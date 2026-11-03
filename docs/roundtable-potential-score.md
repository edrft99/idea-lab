# Potential score from roundtable reports

The site’s Potential score is a provisional read projection of saved GPT, Claude and Grok reports. It replaces the old manual five-factor score in the dashboard, explorer and idea detail APIs. The Manual evaluation button is removed. Manual evaluation records remain in history.

## Calculation

1. Keep verified reports belonging to the exact idea and its current revision.
2. The most recently completed report selects the brief via its input hash. Only reports with the same hash participate; different excerpts, criteria, constraints or rubric versions are never mixed.
3. Select each reviewer’s latest completed report for that brief. Repeated runs and duplicate saves do not add voting weight.
4. A reviewer needs numeric feasibility, success and value scores. Unknown dimensions leave that reviewer unranked, without falling back to an older run or treating unknown as zero.
5. Average the three dimensions for each complete reviewer. Average those totals equally across participating reviewers and round the final result once to 0–100. One complete reviewer is sufficient; the UI shows how many contributed. Confidence is averaged separately and is not a score weight.

Dimension breakdowns show the rounded mean of each dimension across contributing reviewers. Overall score uses unrounded values and can differ slightly from averaging those displayed dimension values.

The latest brief can change after a new assessment. Other agents rejoin the aggregate when they assess that same brief. Editing an idea makes previous-revision reports historical until the current version is reviewed. Merged originals are not given an active roundtable score.

## Persistence and verification

Saved Notion snapshots remain authoritative. Score reads batch one paginated report-datasource query and validate metadata, owner, result/input hashes, generation provenance, storage operation and uniqueness before scoring. A corrupt report makes that idea’s score unavailable without suppressing valid scores for unrelated ideas. Failed reads never fall back to an old manual score.

This change does not write a computed score into Notion’s legacy Priority Score property or overwrite manually approved evaluations. The site computes it from durable reports when read, avoiding idea revision changes that would immediately stale the source assessment. Existing current reports therefore populate the score without a model request, data migration or extra approval. The read APIs expose the derived priorityScore, roundtable-provisional authority and a roundtableScore breakdown; backend mutation/provenance code still reads the original idea record.

Dashboard ranking, high-potential counts, explorer ordering and minimum-score filters all use the derived score. Filtering happens after scoring. Loading report history or scores does not contact a model; existing accepted uncertain storage operations can still be confirmed through the shared recovery path.

Statuses distinguish ready, missing, incomplete and unavailable. The idea page explains each state. Provisional scores are not peer-reviewed panel consensus.
