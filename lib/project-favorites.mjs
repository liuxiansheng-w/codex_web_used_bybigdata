import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const maxProjects = 100;
const maxPathLength = 4096;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function normalizeProjects(value) {
  if (!Array.isArray(value) || value.length > maxProjects) throw invalid('项目列表格式无效。');
  const projects = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > maxPathLength || !path.isAbsolute(item)) throw invalid('项目路径必须是绝对路径。');
    const cwd = path.resolve(item);
    if (!projects.includes(cwd)) projects.push(cwd);
  }
  return projects;
}

export class ProjectFavorites {
  constructor(stateDir) {
    this.directory = stateDir;
    this.file = path.join(stateDir, 'project-favorites.json');
    this.value = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.value) return [...this.value];
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.value = normalizeProjects(parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') this.value = [];
      else this.value = [];
    }
    return [...this.value];
  }

  async list() {
    return { projects: await this.load() };
  }

  async replace(value) {
    const projects = normalizeProjects(value);
    const previous = await this.load();
    this.value = projects;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(this.directory, `.project-favorites-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(projects) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file);
      } catch (error) {
        try { await unlink(temporary); } catch {}
        throw error;
      }
    });
    try { await this.writeQueue; }
    catch (error) { this.value = previous; throw Object.assign(new Error('项目列表保存失败，请稍后重试。'), { status: 503, cause: error }); }
    return { projects: [...projects] };
  }
}

export { normalizeProjects };
