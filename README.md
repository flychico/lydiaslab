# Leo

**Website: [ndhorizon.com](https://ndhorizon.com)**

Leo is a sports prediction model for the NFL, NBA and MLB. Every game gets a written read before it starts, and every read is graded in public afterwards, wins and losses alike.

## On the site

- [NFL predictions this week](https://ndhorizon.com/nfl/week/): win chance, spread, total and anytime touchdown scorer chances for every game
- [NFL team predictions](https://ndhorizon.com/nfl/teams/): every game Leo analyzed for each of the 32 teams
- [NBA scoreboard](https://ndhorizon.com/nba/scoreboard/) and [NBA predictions by night](https://ndhorizon.com/nba/predictions/)
- [MLB teams](https://ndhorizon.com/mlb/teams/): every 2026 game Leo analyzed, by team
- Leo's record: [NFL](https://ndhorizon.com/nfl/results/), [NBA](https://ndhorizon.com/nba/results/), [MLB](https://ndhorizon.com/results/)
- [Free card by email](https://ndhorizon.com/membership/#free)

## How Leo works

- Each read is saved before the game starts and never changed afterwards. The read saved last before kickoff or tip is the one that is graded.
- The betting line is shown beside Leo's number and used only to grade it, never as an input to the model.
- Model changes are made one at a time and only after a walk forward backtest.

## This repository

This is the code behind [ndhorizon.com](https://ndhorizon.com): the models in `scripts/lib/`, the page and email writers in `scripts/`, the saved reads and grades in `data/`, and the GitHub Actions in `.github/workflows/` that gather data, publish each card and grade the results.

For entertainment and information. Leo's numbers are not betting advice and no model can promise outcomes. 21+. If gambling stops being fun, call 1-800-MY-RESET.
