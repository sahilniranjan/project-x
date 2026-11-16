---
name: project-x-interview-prep
description: Full interview prep package for a specific company and role
---

# Run Full Interview Prep

Run full interview prep for the following company and role:

$ARGUMENTS

Load the project-x skill:

```javascript
skill({ name: "project-x" })
```

Then run the `interview-prep` mode for that company and role. It saves the report to `interview-prep/{company-slug}-{role-slug}.md` under the data root; `/project-x-interview-intel` shows a saved one without researching again.
