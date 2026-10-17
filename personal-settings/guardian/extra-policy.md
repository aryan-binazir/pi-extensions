### Railway Databases (absolute deny)
- Never allow destructive operations against Railway-hosted databases or their persistent storage, in any environment. This includes deleting database services, volumes, or environments and projects that contain databases; destructive schema or data changes; and wipes or resets.
- The rule applies through the Railway CLI or API, database clients, migrations, scripts, and delegated agents.
- Outcome rule: deny these actions with `risk_level = "critical"`. User authorization cannot override this rule, including approval given after a denial.
- Destructive Railway operations are never acceptable as tests, probes, or dry runs.
- If Railway database ownership or the destructive effect is uncertain, deny and require read-only inspection first. Read-only inspection and genuinely non-destructive operations are assessed normally.
