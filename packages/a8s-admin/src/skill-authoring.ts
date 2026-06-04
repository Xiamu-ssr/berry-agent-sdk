// ============================================================
// @berry-agent/a8s-admin — Skill authoring skill (skill-creator)
// ============================================================
// A system skill that teaches an agent to author NEW skills in the correct
// SKILL.md format and install them into its own home. This is what makes the
// skill system self-extending: the three sources of skills are (1) system
// skills shipped here, (2) skills a product installs from a market (ClawHub),
// and (3) skills an agent writes for itself — this skill enables (3).
//
// The agent writes skills with ordinary file tools into home/skills/<name>/
// (its workspace Hand can do this directly), or a product/runtime exposes an
// install path. Either way the contract is the SKILL.md format below.

export const SKILL_CREATOR_SKILL = `---
name: skill-creator
description: Author a new skill for yourself in the correct SKILL.md format and save it so it shows up in your skill index next turn.
whenToUse: When you've worked out a reusable procedure and want to capture it as a skill — "remember how to do X", "turn this into a skill", "distill what we just did". Also when asked to create or edit a skill.
---

# Authoring a skill

A skill is a folder under your home skills dir: \`skills/<name>/SKILL.md\`,
optionally with \`scripts/\` and \`references/\` beside it. The harness scans
these folders, reads each SKILL.md's frontmatter, and lists your skills in
your system prompt so you know what you have. Writing a new one makes you
better at a recurring task without changing any code.

## The SKILL.md format

Every skill is a single \`SKILL.md\` with YAML frontmatter + a Markdown body:

\`\`\`
---
name: <kebab-case-id>          # required; must match the folder name
description: <one line>        # required; shown in your skill index — make it
                               #   say plainly what the skill does
whenToUse: <one line>          # optional but recommended; the trigger that
                               #   should make future-you reach for this skill
---

# <Title>

<The actual instructions. Write them to your future self: concrete steps,
the exact commands/tools to use, the gotchas you just learned. Keep it tight
— a skill is a checklist + the hard-won details, not an essay.>
\`\`\`

## Rules that keep skills useful

1. **name = folder name**, kebab-case, unique. \`description\` and \`whenToUse\`
   are the only things the index shows before the skill is opened, so they
   must carry the "should I use this?" decision on their own.
2. **Body is for future-you mid-task.** Lead with the steps. Put the
   non-obvious specifics (flags, paths, order, failure modes) where they'll
   be seen. Cut throat-clearing.
3. **Scripts go in \`scripts/\`** beside SKILL.md and you drive them from the
   body (e.g. "run \`scripts/check.sh\`"). The skill is the knowledge; the
   script is the tool it points at — same split as a CLI + its skill.
4. **One skill = one coherent capability.** If it sprawls, split it.

## Saving it

Write \`skills/<name>/SKILL.md\` (and any \`scripts/\`) under your home with your
file tools. It becomes available on your next turn — the index refreshes from
disk. To revise a skill, just rewrite its SKILL.md. To drop one, delete its
folder.
`;
