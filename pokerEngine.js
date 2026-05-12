const crypto = require('crypto');

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = [
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '4', value: 4 },
  { label: '5', value: 5 },
  { label: '6', value: 6 },
  { label: '7', value: 7 },
  { label: '8', value: 8 },
  { label: '9', value: 9 },
  { label: 'T', value: 10 },
  { label: 'J', value: 11 },
  { label: 'Q', value: 12 },
  { label: 'K', value: 13 },
  { label: 'A', value: 14 },
];

function createDeck() {
  const deck = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push({ rank: rank.label, value: rank.value, suit });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function dealCards(deck, count) {
  return deck.splice(0, count);
}

function compareHandScores(a, b) {
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

function getStraightHigh(values) {
  const unique = Array.from(new Set(values)).sort((a, b) => b - a);
  if (unique.length < 5) return null;
  for (let i = 0; i <= unique.length - 5; i += 1) {
    const window = unique.slice(i, i + 5);
    if (window[0] - window[4] === 4) return window[0];
  }
  const wheel = [14, 5, 4, 3, 2];
  return wheel.every(v => unique.includes(v)) ? 5 : null;
}

function evaluateFiveCardHand(cards) {
  const values = cards.map(c => c.value);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const straightHigh = getStraightHigh(values);

  const counts = values.reduce((acc, v) => {
    acc[v] = (acc[v] || 0) + 1;
    return acc;
  }, {});

  const groups = Object.entries(counts)
    .map(([value, count]) => ({ value: Number(value), count }))
    .sort((a, b) => (b.count - a.count) || (b.value - a.value));

  const sortedValues = values.slice().sort((a, b) => b - a);

  if (isFlush && straightHigh) {
    return { score: [8, straightHigh], name: 'Straight Flush' };
  }

  if (groups[0].count === 4) {
    const kicker = groups[1].value;
    return { score: [7, groups[0].value, kicker], name: 'Four of a Kind' };
  }

  if (groups[0].count === 3 && groups[1].count === 2) {
    return { score: [6, groups[0].value, groups[1].value], name: 'Full House' };
  }

  if (isFlush) {
    return { score: [5, ...sortedValues], name: 'Flush' };
  }

  if (straightHigh) {
    return { score: [4, straightHigh], name: 'Straight' };
  }

  if (groups[0].count === 3) {
    const kickers = groups.slice(1).map(g => g.value).sort((a, b) => b - a);
    return { score: [3, groups[0].value, ...kickers], name: 'Three of a Kind' };
  }

  if (groups[0].count === 2 && groups[1].count === 2) {
    const highPair = Math.max(groups[0].value, groups[1].value);
    const lowPair = Math.min(groups[0].value, groups[1].value);
    const kicker = groups.find(g => g.count === 1).value;
    return { score: [2, highPair, lowPair, kicker], name: 'Two Pair' };
  }

  if (groups[0].count === 2) {
    const kickers = groups.slice(1).map(g => g.value).sort((a, b) => b - a);
    return { score: [1, groups[0].value, ...kickers], name: 'One Pair' };
  }

  return { score: [0, ...sortedValues], name: 'High Card' };
}

function evaluateBestHand(cards) {
  if (!cards || cards.length < 5) return null;
  let best = null;
  for (let i = 0; i < cards.length - 4; i += 1) {
    for (let j = i + 1; j < cards.length - 3; j += 1) {
      for (let k = j + 1; k < cards.length - 2; k += 1) {
        for (let l = k + 1; l < cards.length - 1; l += 1) {
          for (let m = l + 1; m < cards.length; m += 1) {
            const combo = [cards[i], cards[j], cards[k], cards[l], cards[m]];
            const result = evaluateFiveCardHand(combo);
            if (!best || compareHandScores(result.score, best.score) > 0) {
              best = result;
            }
          }
        }
      }
    }
  }
  return best;
}

function computeSidePots(players) {
  const contributions = players.map(p => ({
    id: p.id,
    amount: p.handBet || 0,
    eligible: !p.folded && !p.eliminated,
  }));

  const levels = Array.from(new Set(contributions.map(c => c.amount).filter(a => a > 0)))
    .sort((a, b) => a - b);

  let prev = 0;
  const pots = [];
  for (const level of levels) {
    const contributors = contributions.filter(c => c.amount >= level);
    const amount = (level - prev) * contributors.length;
    if (amount > 0) {
      pots.push({
        amount,
        level,
        eligibleIds: contributors.filter(c => c.eligible).map(c => c.id),
      });
    }
    prev = level;
  }
  return pots;
}

function getSeatOrder(players, dealerIndex) {
  if (dealerIndex < 0) return players.map(p => p.id);
  const order = [];
  for (let offset = 1; offset <= players.length; offset += 1) {
    order.push(players[(dealerIndex + offset) % players.length].id);
  }
  return order;
}

function determinePotWinners(players, board, dealerIndex) {
  const active = players.filter(p => !p.folded && !p.eliminated);
  const handRanks = {};

  active.forEach(p => {
    if (p.holeCards && p.holeCards.length) {
      handRanks[p.id] = evaluateBestHand([...board, ...p.holeCards]);
    }
  });

  const pots = computeSidePots(players).map(pot => {
    const eligible = pot.eligibleIds.filter(id => handRanks[id]);
    if (!eligible.length) {
      return { ...pot, winners: [], bestHand: null };
    }

    let bestId = eligible[0];
    eligible.forEach(id => {
      if (compareHandScores(handRanks[id].score, handRanks[bestId].score) > 0) {
        bestId = id;
      }
    });

    const winners = eligible.filter(id => compareHandScores(handRanks[id].score, handRanks[bestId].score) === 0);
    return {
      ...pot,
      winners,
      bestHand: handRanks[bestId].name,
    };
  });

  return { pots, handRanks, seatOrder: getSeatOrder(players, dealerIndex) };
}

module.exports = {
  createDeck,
  shuffleDeck,
  dealCards,
  evaluateBestHand,
  compareHandScores,
  computeSidePots,
  determinePotWinners,
};
