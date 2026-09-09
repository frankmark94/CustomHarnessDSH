/**
 * claude-bridge — bring Claude Code's memory, global instructions and skills
 * into the DeepSeek Harness system prompt. No migration, no copying: the
 * files are read where Claude Code keeps them, on every prompt assembly.
 *
 * Adapted from YYTbit/dsh-plugin-claude-bridge (MIT). Rewritten for this
 * harness build because the upstream package:
 *   - keyed memory off the harness PROCESS cwd (always DSH_HOME), not the
 *     session's workspace, and with the wrong drive-letter case for the keys
 *     Claude Code actually writes on Windows (`c--Users-…`);
 *   - used async text providers, which this build's prompt assembler calls
 *     synchronously.
 *
 * What is injected, per session:
 *   - `claude-bridge:memory`  (dynamic context) — the memory files under
 *     `~/.claude/projects/<key of the session cwd>/memory/*.md`, feedback
 *     first, then project, reference, user; capped at `maxMemoryBytes`.
 *   - `claude-bridge:global`  (section, early) — `~/.claude/CLAUDE.md`, when
 *     it exists. The workspace's own AGENTS.md / CLAUDE.md is already loaded
 *     by the harness's agent-instructions plugin and is NOT duplicated here.
 *   - `claude-bridge:skills`  (dynamic context) — a name + description
 *     catalog of `~/.claude/skills/<name>/SKILL.md` (+ `extraSkillDirs`).
 *
 * Everything read here is sent to the model provider as part of the prompt.
 */
import { homedir } from 'node:os';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import z from '@deepseek-ai/schemastery';

export const name = 'claude-bridge';
export const inject = ['systemPrompt'];

export const Config = z.object({
  /** Claude Code home. Default `~/.claude`. */
  claudeHome: z.string(),
  enableMemory: z.boolean().default(true),
  /** Cap on the rendered memory block (bytes). Entries are whole; the first that overflows stops the list. */
  maxMemoryBytes: z.natural().default(8192),
  enableGlobalInstructions: z.boolean().default(true),
  enableSkills: z.boolean().default(true),
  maxSkills: z.natural().default(30),
  /** Extra skill roots (absolute, or `~/…`). */
  extraSkillDirs: z.array(z.string()).default([]),
  /** Re-read files at most this often per session (ms). */
  cacheMs: z.natural().default(3000),
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Claude Code's project key for a path: every `:`, `/` and `\` becomes `-`, so
 * `C:\Users\x\proj` → `C--Users-x-proj` (the colon AND the backslash each
 * yield a dash — upstream dropped the colon and got `C-Users-…`, which never
 * matches). Drive-letter case varies (`c--` vs `C--`); callers match loosely.
 */
export function encodeProjectPath(path) {
  return path.replace(/[:/\\]/g, '-');
}

/** Find the `<projects>/<key>` folder for a workspace, tolerating drive-letter and path case differences. */
export function findProjectDir(projectsDir, cwd) {
  const wanted = encodeProjectPath(cwd).replace(/-+$/, '').toLowerCase();
  let entries;
  try { entries = readdirSync(projectsDir); } catch { return undefined; }
  const exact = entries.find((e) => e === encodeProjectPath(cwd));
  if (exact) return join(projectsDir, exact);
  const loose = entries.find((e) => e.toLowerCase() === wanted);
  return loose ? join(projectsDir, loose) : undefined;
}

/** Minimal YAML-frontmatter parser: flat `key: value` plus one nesting level (`metadata:\n  type: x` → `metadata.type`). */
export function parseFrontmatter(content) {
  const m = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content.trim() };
  const meta = {};
  let parent = null;
  for (const line of m[1].split(/\r?\n/)) {
    const top = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (top) { parent = top[2] === '' ? top[1] : null; if (top[2] !== '') meta[top[1]] = top[2].trim(); continue; }
    const nested = line.match(/^\s+([A-Za-z][\w-]*):\s*(.*)$/);
    if (nested && parent) meta[`${parent}.${nested[1]}`] = nested[2].trim();
  }
  return { meta, body: m[2].trim() };
}

const TYPE_PRIORITY = { feedback: 0, project: 1, reference: 2, user: 3 };

/** Load `*.md` memory files (not MEMORY.md) from one directory, sorted feedback > project > reference > user. */
export function loadMemories(dir) {
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md'); } catch { return []; }
  const out = [];
  for (const file of files) {
    try {
      const { meta, body } = parseFrontmatter(readFileSync(join(dir, file), 'utf8'));
      if (body === '') continue;
      out.push({ name: meta.name ?? file.replace(/\.md$/, ''), description: meta.description ?? '', type: meta['metadata.type'] ?? meta.type ?? 'unknown', content: body });
    } catch { /* unreadable: skip */ }
  }
  return out.sort((a, b) => (TYPE_PRIORITY[a.type] ?? 99) - (TYPE_PRIORITY[b.type] ?? 99) || a.name.localeCompare(b.name));
}

export function renderMemories(memories, maxBytes, cwd) {
  if (memories.length === 0) return '';
  const lines = [`# Agent memory (from Claude Code, for ${cwd})`, '', 'Facts and preferences recorded in earlier sessions. Prefer them over guessing; verify file/flag names they mention still exist.', ''];
  let bytes = 0;
  for (const m of memories) {
    const block = [`## ${m.name}${m.type !== 'unknown' ? ` (${m.type})` : ''}`, m.description ? `> ${m.description}` : '', '', m.content, ''].filter((l, i) => i !== 1 || l !== '').join('\n');
    if (bytes + block.length > maxBytes) break;
    lines.push(block);
    bytes += block.length;
  }
  return lines.join('\n');
}

/** Discover `<root>/<name>/SKILL.md` and flat `<root>/<name>.md` skills. */
export function loadSkills(roots) {
  const skills = [];
  for (const root of roots) {
    let entries;
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      const full = join(root, entry);
      let file;
      try {
        if (statSync(full).isDirectory()) { const s = join(full, 'SKILL.md'); if (existsSync(s)) file = s; }
        else if (entry.endsWith('.md') && entry !== 'MEMORY.md') file = full;
      } catch { continue; }
      if (!file) continue;
      try {
        const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'));
        if (body === '') continue;
        skills.push({ name: meta.name ?? entry.replace(/\.md$/, ''), description: meta.description ?? '', argumentHint: meta['argument-hint'], level: meta.level !== undefined ? Number(meta.level) : undefined, path: file });
      } catch { /* skip */ }
    }
  }
  return skills.sort((a, b) => (a.level ?? 99) - (b.level ?? 99) || a.name.localeCompare(b.name));
}

export function renderSkillCatalog(skills) {
  if (skills.length === 0) return '';
  return ['# Skills available from Claude Code', '', 'Read the SKILL.md at the path when a task matches; follow its instructions.', '',
    ...skills.map((s) => `- **${s.name}**${s.argumentHint ? ` \`${s.argumentHint}\`` : ''}: ${s.description} (${s.path})`)].join('\n');
}

const expandHome = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const claudeHome = resolvePath(expandHome(config.claudeHome ?? join(homedir(), '.claude')));
  const projectsDir = join(claudeHome, 'projects');
  const globalFile = join(claudeHome, 'CLAUDE.md');
  const skillRoots = [join(claudeHome, 'skills'), ...(config.extraSkillDirs ?? []).map(expandHome)];

  /** Tiny time-based cache so a prompt assembly does not re-read disk on every step. */
  const cache = new Map();
  function cached(key, produce) {
    const hit = cache.get(key);
    const now = Date.now();
    if (hit !== undefined && now - hit.at < config.cacheMs) return hit.value;
    const value = produce();
    cache.set(key, { at: now, value });
    return value;
  }

  const sessionCwd = (context) => {
    const session = context?.agent?.session;
    return session?.header?.cwd ?? session?.cwd ?? undefined;
  };

  if (config.enableMemory) {
    ctx.systemPrompt.context({
      name: 'claude-bridge:memory',
      order: 130,
      text: (context) => {
        const cwd = sessionCwd(context);
        if (!cwd) return '';
        return cached(`memory:${cwd}`, () => {
          const dir = findProjectDir(projectsDir, cwd);
          if (!dir) return '';
          return renderMemories(loadMemories(join(dir, 'memory')), config.maxMemoryBytes, cwd);
        });
      },
    });
  }

  if (config.enableGlobalInstructions) {
    ctx.systemPrompt.section({
      name: 'claude-bridge:global',
      order: 5,
      text: () => cached('global', () => {
        try {
          const text = readFileSync(globalFile, 'utf8').trim();
          return text === '' ? '' : `# Global instructions (from ~/.claude/CLAUDE.md)\n\n${text}`;
        } catch { return ''; }
      }),
    });
  }

  if (config.enableSkills) {
    ctx.systemPrompt.context({
      name: 'claude-bridge:skills',
      order: 131,
      text: () => cached('skills', () => renderSkillCatalog(loadSkills(skillRoots).slice(0, config.maxSkills))),
    });
  }

  const memoryProjects = (() => { try { return readdirSync(projectsDir).length; } catch { return 0; } })();
  ctx.logger.info(`claude-bridge: ready; ${claudeHome} (${memoryProjects} project folders, global CLAUDE.md ${existsSync(globalFile) ? 'present' : 'absent'}, skill roots: ${skillRoots.join(', ')})`);
}
