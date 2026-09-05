# Finding Template

Use this shape for each finding when reviewing an implementation against a plan.

````markdown
**P<severity>: <Finding Title>**

<One short paragraph explaining the failure mode and impact.>

Location: [file.py](/absolute/path/to/file.py:123)

```python
<minimal code snippet>
```

Why this matters:
<Explain the concrete behavior that can fail. Tie it back to the plan when possible.>

Recommendation:
<Give the narrowest fix or validation addition.>
````

For combined critiques, repeat the block for each finding and then add:

```markdown
**Review Notes**

Checked: <plan path, changed files, key callers, tests/scripts/docs inspected>.

Not run: <commands skipped and why>.

Assumptions: <any base branch, runtime path, or data-shape assumptions>.
```
