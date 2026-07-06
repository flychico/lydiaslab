# Stat Signal Map

This file separates signal from noise for LyDia's MLB engine.

## Strong signal stats

### Starting pitcher

Use:

- xERA
- FIP
- xFIP
- SIERA
- K%
- BB%
- K-BB%
- Ground-ball rate
- Hard-hit rate allowed
- Barrel rate allowed
- Recent velocity change
- Pitch count / workload context
- Splits vs opponent handedness profile

Why:

Starting pitching creates large MLB pricing edges. Raw ERA is not enough because defense, sequencing, park, and luck can distort it.

### Offense

Use:

- wRC+
- wOBA
- xwOBA
- ISO
- K%
- BB%
- Hard-hit rate
- Barrel rate
- Split vs pitcher handedness
- Rolling 14-day and 30-day form
- Projected lineup quality

Why:

We need to know whether today's lineup matches up well against today's pitcher type, not whether the team has a good brand name.

### Bullpen

Use:

- Bullpen FIP/xFIP
- Last 3-day usage
- Back-to-back appearances
- High-leverage arm availability
- Recent bullpen workload
- Closer/setup availability

Why:

Full-game moneyline picks can die late if the bullpen edge is ignored.

### Market

Use:

- Opening line
- Current line
- Consensus line
- Market-implied probability
- No-vig probability
- Line movement
- Closing-line value after result
- Playable price range

Why:

The bet is price versus probability. The team name is secondary.

## Medium signal stats

Use as supporting evidence:

- Team recent form
- Home/road split
- Defensive quality
- Catcher defense/framing
- Base-running value
- Travel/rest disadvantage
- Umpire tendency for totals, if available and reliable

## Low signal / dangerous noise

Do not use as primary pick logic:

- Team win-loss record
- Pitcher wins/losses
- Raw ERA by itself
- Batting average by itself
- Batter vs pitcher history with tiny sample
- Last game result
- Vague revenge angles
- Public betting percentage by itself
- Competitor confidence language
- Social media hype
- Parlay popularity

## Rule

Narrative can support a pick. Narrative cannot create a pick.
