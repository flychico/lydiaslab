# LyDia Edge Engine Methodology

## Core formula

```text
LyDia Edge = LyDia Projected Probability - Market No-Vig Implied Probability
```

A team being better is not enough. A pick only exists when the price appears mispriced.

## Step 1: Convert odds to implied probability

American odds conversion:

```text
For negative odds: implied probability = abs(odds) / (abs(odds) + 100)
For positive odds: implied probability = 100 / (odds + 100)
```

Example:

```text
-120 = 120 / 220 = 54.55%
+130 = 100 / 230 = 43.48%
```

## Step 2: Remove vig when comparing both sides

If Team A is -120 and Team B is +110:

```text
A implied = 54.55%
B implied = 47.62%
Total = 102.17%
A no-vig = 54.55 / 102.17 = 53.39%
B no-vig = 47.62 / 102.17 = 46.61%
```

Use no-vig probability for true market comparison.

## Step 3: Score edge quality

The Edge Score is a 100-point structure:

```text
Starting Pitcher Edge:       25 points
Offensive Matchup Edge:     20 points
Bullpen Edge:               15 points
Lineup/Injury Edge:         10 points
Park/Weather Edge:          10 points
Market/Price Edge:          15 points
Competitor Logic Signal:     5 points
```

## Step 4: Apply hard gates

Even high score games are rejected if any hard gate fails:

- Starting pitcher conflict
- Odds stale or unavailable
- Line has moved past playable price
- Major lineup uncertainty for a key pick thesis
- Weather threatens total/prop logic
- Reasoning is mostly narrative
- Competitor consensus is present but no independent LyDia edge exists

## Step 5: Assign status

```text
85-100: Strong Play Candidate
75-84:  Play Candidate
65-74:  Lean Only
Below 65: No Play
```

## Edge threshold

Recommended V2 default:

```text
Official pick minimum raw edge: +3.0 percentage points
Strong play minimum raw edge:   +5.0 percentage points
```

These thresholds can be tuned after enough tracked results.

## Key rule

No price edge = no official pick.
