import { EventEmitter } from 'node:events';

/** A skill picked for a prompt: an agent slash command, or a markdown skill when `path` is set. */
export interface PickedSkill {
  name: string;
  path?: string;
}

/** The instructions of a markdown skill, sent with the prompt. */
export interface SkillInstructions {
  name: string;
  body: string;
}

/**
 * Skills picked for an agent's next prompt. A pick applies to one prompt
 * only: `take` hands it to the turn and clears it.
 */
export class SkillSelection extends EventEmitter {
  private readonly picked = new Map<string, PickedSkill[]>();

  get(agentName: string): PickedSkill[] {
    return this.picked.get(agentName) ?? [];
  }

  set(agentName: string, skills: PickedSkill[]): void {
    if (skills.length) { this.picked.set(agentName, [...skills]); } else { this.picked.delete(agentName); }
    this.emit('changed', agentName);
  }

  /** The skills for this prompt; clears them for the next one. */
  take(agentName: string): PickedSkill[] {
    const skills = this.get(agentName);
    if (skills.length) { this.set(agentName, []); }
    return skills;
  }
}

/**
 * Prompt text that runs the picked skills. Markdown skills are sent as
 * instructions ahead of the prompt. One slash command goes to the agent as
 * typed (`/review ...`); agents only run a leading slash command, so several
 * are named in a preamble the agent acts on instead.
 */
export function promptWithSkills(
  prompt: string,
  commands: string[],
  instructions: SkillInstructions[] = [],
): string {
  const blocks = instructions.map(s => `<skill name="${s.name}">\n${s.body}\n</skill>`);
  const body = blocks.length ? `Follow these skills for this request:\n\n${blocks.join('\n\n')}\n\n${prompt}`.trim() : prompt;
  if (!commands.length) { return body; }
  if (commands.length === 1) { return `/${commands[0]} ${body}`.trim(); }
  return `Use these skills for this request: ${commands.map(s => `/${s}`).join(', ')}\n\n${body}`.trim();
}

/** Short picker label for the picked skills, e.g. "review +2". */
export function skillsLabel(skills: string[]): string {
  return skills.length > 1 ? `${skills[0]} +${skills.length - 1}` : skills[0] ?? 'Skills';
}
