# Effectiveness evaluation

Answers "is this actually doing anything", with each failure mode measured
separately, because they fail independently.

```sh
node eval/run-all.mjs
```

| Script | Question | Fails when |
|---|---|---|
| `recall-precision.mjs` | When the user hits a known problem, is its lesson selected? | Conditions match nothing, or the gate holds the lesson back |
| `delivery.mjs` | Of the lessons published, how many ever reached a session? | Documents never enter the catalog, or are never chosen |
| `session-recurrence.mjs` | After delivery, does the family recur less often? | The lesson arrives and nothing changes |
| `project-drift.mjs` | Did the whole project go quiet anyway? | The drop is the project's trend, not the lesson |
| `net-effect.mjs` | Family change minus project change | The only number attributable to the lesson |
| `lifecycle-effect.mjs` | Does demoting a contradicted family change a turn — in the right direction, and only where it should? | Demotion never fires, or it reorders lessons it has no evidence about |

## Things that made earlier measurements wrong

Recorded here so they are not repeated:

**Counting review jobs as occurrences.** One session produced 22 review rows for
a single family — the same conversation re-triggering the same complaint. Counts
must be distinct sessions, not rows.

**Comparing delivered families to never-delivered ones in one shared window.**
123 of the 210 control families first appeared after that window's midpoint, so
their "before" was structurally zero and the control read as a +184% increase no
matter what the lessons did.

**Comparing raw counts before and after delivery.** The "after" window is usually
shorter, so it holds fewer occurrences for reasons unrelated to the lesson. Every
rate here is per day, over equal-length windows around the delivery timestamp.

**Skipping the control.** A family's recurrence falls after delivery. So does an
undelivered family's, when the project moves on. Only the difference between the
two can be attributed to the lesson.
