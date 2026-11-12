There may be other agents working at the same time as you. Be cognisant of this when making changes and performing git operations. Do not overwrite other agents' changes.

When making changes, ask me any questions you need about my priorities, preferences, purpose, etc. Feel free to discuss trade-offs with different implementation approaches, alternative plans, etc. Ensure your changes work on all job sites, not just the examples listed or the most common ones. AutoApply needs to be compatible with a wide variety of job sites.

Ensure your changes DO NOT ALTER ANY OTHER pre-existing functionality - that is, everything that was working before the change should continue working after the change.

Make all implementation and operational decisions according to these priorities, in this order:

1. AutoApply MUST NOT fall for AI honeypots/tricks/traps
2. AutoApply must be as accurate as possible in the fields it autofills, the navigation it takes, etc,
3. AutoApply must keep token usage minimal
4. AutoApply must apply to jobs fast
5. AutoApply must use little to no background resources

Feel free to run any tests you need.
