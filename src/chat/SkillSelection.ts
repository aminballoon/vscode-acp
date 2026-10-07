import { EventEmitter } from 'node:events';

/**
 * Skills (agent slash commands) picked for an agent's next prompt. A pick
 * applies to one prompt only: `take` hands it to the turn and clears it.
 */
export class SkillSelection extends EventEmitter {
  private readonly picked = new Map<string, string[]>();

  get(agentName: string): string[] {
    return this.picked.get(agentName) ?? [];
  }

  set(agentName: string, skills: string[]): void {
    if (skills.length) { this.picked.set(agentName, [...skills]); } else { this.picked.delete(agentName); }
    this.emit('changed', agentName);
  }

  /** The skills for this prompt; clears them for the next one. */
  take(agentName: string): string[] {
    const skills = this.get(agentName);
    if (skills.length) { this.set(agentName, []); }
    return skills;
  }
}

/**
 * Prompt text that runs the picked skills. One skill goes to the agent as a
 * slash command (`/review ...`); agents only run a leading slash command,
 * so several are named in a preamble the agent acts on instead.
 */
export function promptWithSkills(prompt: string, skills: string[]): string {
  if (!skills.length) { return prompt; }
  if (skills.length === 1) { return `/${skills[0]} ${prompt}`.trim(); }
  return `Use these skills for this request: ${skills.map(s => `/${s}`).join(', ')}\n\n${prompt}`.trim();
}

/** Short picker label for the picked skills, e.g. "review +2". */
export function skillsLabel(skills: string[]): string {
  return skills.length > 1 ? `${skills[0]} +${skills.length - 1}` : skills[0] ?? 'Skills';
}
