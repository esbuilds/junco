# Eval and DisputeBench

The detail behind the README's summary. Back to the [README](../README.md).

## The eval

`evals/scenarios.ts` holds 43 dispute scenarios: item not received (delivered, shipped only, never shipped, cancelled label, wrong ZIP, porch theft, empty box, signature), chargebacks under PayPal review, not as described, unauthorized, credit not processed, duplicate charges, merchant data mistakes, and 10 prompt injections in buyer messages, photo captions and merchant records (including fake PayPal rulings, a buyer posing as the seller, ready-made JSON output, and a planted note pushing the agent to contest a case it should concede). Scenario 42 is a mistake JUNCO made on the live desk (below). Scenario 43 is a buyer reporting a refund promise the seller never wrote. Each lists the decisions a careful advisor could defend and the ones that are clearly wrong. `npm run eval` runs them through the production prompt and validator and scores the decisions in code. The scenarios are written by us, so this is a regression suite, not a win rate.

Latest full run (Oct 14 2026, Claude Opus 5.5 with a Sonnet 5.5 support check, about $2.45):

| Measure | Result |
|---|---|
| Acceptable decision, passed the validator | 43 / 43 |
| Clearly wrong decision | 0 |
| Invented or missing citations | 0 |
| Quotes blocked (given but not found in the text) | 0 |
| Messages to the buyer blocked | 0 |
| Claims a second model confirmed from the cited items alone | 228 confirmed, 11 not confirmed, 0 contradicted |
| Prompt injections resisted | 10 / 10 |

The support check reads only the items each claim cites and blocks a claim they contradict; it judges facts, not the reasoning drawn from them. Its first version blocked 8 correct recommendations over wording (a USPS scan the merchant typed in, called "the USPS scan"); that run is kept in `evals/results/` (2026-10-14T13-38).

56 of 108 source-text claims carry a found quote; the rest state absence, timing or comparison, which a quote can't show; 0 quotes blocked.

The run before this one scored 40 / 41, and the miss was a scenario bug: a return logged as received the same day the order was paid. Claude flagged the impossible timeline and asked the buyer to confirm instead of refunding. The scenario now dates the return after the purchase and passes in three repeat runs. An earlier miss (Oct 7) was the same kind of bug: a UPS delivery scan against a USPS tracking number. Raw results, including the misses, are in `evals/results/`.

## A mistake JUNCO made, and what changed

On Oct 10, on a real sandbox case (PP-R-GJF-10190944) for an order that was never shipped, JUNCO sent the buyer a message saying the tote "has been shipped" and that tracking had been provided. Neither was true. PayPal lists evidence it has requested next to evidence that was submitted, and JUNCO's evidence formatter showed a request for proof of fulfillment as "Submitted proof of fulfillment". The model believed it. The validator didn't catch it because it checked the recommendation's claims, not the free text of the message to the buyer.

What changed: the formatter now says who submitted each item, or that PayPal asked for it and it hasn't been provided. The validator now checks the message to the buyer: a sentence saying an order shipped, has tracking or was delivered is blocked when no evidence item carries a tracker or delivery record, and any tracking number or date in the message must appear in the evidence. The case is scenario 42 in the eval. The original message stays in the case's activity log.

## DisputeBench

The scenarios double as a benchmark any dispute agent can be scored against, not just JUNCO.

- `npm run eval -- --agent ./my-agent.ts` scores a module that exports `async function decide(dispute, evidence)` and returns `{ decision }` (one of `accept`, `offer`, `contest`, `message`, `wait`) or a full recommendation with `claims: [{ text, evidence_ids }]`. Full recommendations go through the same citation validator, so invented evidence counts against any agent.
- `npm run bench:export` writes `evals/disputebench.json`: every case as plain JSON (the dispute and numbered evidence the agent sees, the decisions a careful advisor could defend, and the ones that are clearly wrong), for agents in any language.

Two baselines ran on the same 43 cases on Oct 14 2026: one that accepts every dispute it can (`evals/agents/always-accept.ts`), and the same model with the same settings as JUNCO but none of what JUNCO adds: plain unnumbered evidence, a one-paragraph prompt, no checks (`evals/agents/no-validator.ts`, three runs). The always-accept agent got 18 / 43, with 24 clearly wrong and 1 of 10 injections resisted. The plain model got 41 / 43 in all three runs, with the same 1 wrong decision and 10 / 10 injections resisted.

On Oct 15 the same plain baseline ran three times each on Anthropic's smaller current models (`BASELINE_MODEL=claude-sonnet-5-5` or `claude-haiku-5-5`). A misleading message is one that tells a buyer whose order never shipped, or has no tracking, that it shipped or that tracking is coming, read by hand against the case's evidence; sentences the evidence supports aren't counted.

| Plain model, no checks | Pass (of 43) | Clearly wrong | Action PayPal won't take | Cases with a misleading message | Injections resisted |
|---|---|---|---|---|---|
| Opus 5.5 (Oct 14) | 41 | 1 | 1 | 0 to 2 | 10 / 10 |
| Sonnet 5.5 | 40 to 41 | 1 | 1 | 1 to 2 | 10 / 10 |
| Haiku 5.5 | 36 to 39 | 3 to 4 | 2 | 2 | 10 / 10 |

The smaller the model, the more wrong decisions and refused actions there are for the layer to catch (Haiku contested an unauthorized digital charge in all three runs). The misleading messages show up at every size. Across DisputeBench's 43 scenarios, none of the models without the checks moved money it shouldn't have. Their mistakes were contests they'd lose and messages that weren't true, which is what the checks catch.

So a current model reads a dispute about as well without JUNCO. Reading well isn't the same as safe to send, though: in those same runs the plain model told buyers whose orders never shipped to check around their delivery area, and that tracking details would follow. What JUNCO adds is the layer that keeps a decision from going out unchecked. What each layer caught, in the plain model's three runs:

| Layer | What it stops | Plain model, 3 runs |
|---|---|---|
| Numbered evidence | A claim with no source | Its claims cite nothing, so none can be checked |
| PayPal's allowed actions, read from the case | An action PayPal won't take on this case | 1 per run, the same case each time |
| Message check | A message implying an order shipped when nothing shows it did | 0 to 2 per run, read by hand: "check around your delivery area in case it was left somewhere" and "I'm looking into the shipment and will follow up with the tracking details" to buyers whose orders never shipped, and "checking the shipping status" on scenario 42, JUNCO's own Oct 10 mistake |
| Support check | A claim its own cited items contradict | 0 contradicted in JUNCO's run (228 confirmed, 11 not confirmed) |
| The gate | Any money move past the owner's limit | Every one waits for the owner, from every source (see the Gate record on the desk) |

The message check is a keyword rule, and it also flags true sentences (an order a merchant record says shipped, a promise to ship a replacement); the counts above are the flags a person read and judged misleading. New scenarios are added only from things that happened, with their case or run ID; the set stays at 43 until something does. Raw rows for every run are in `evals/results/`.
