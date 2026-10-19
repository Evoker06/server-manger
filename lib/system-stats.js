'use strict';
// Нагрузка процессора и памяти: общая по компьютеру и по дереву процессов приложения.
const os = require('os');
const { promisify } = require('util');
const { execFile } = require('child_process');
const pidusage = require('pidusage');
const execFileAsync = promisify(execFile);

module.exports = function createSystemStats() {
async function pidTree(root) {
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 5000 });
    const kids = new Map();
    for (const l of stdout.split('\n')) {
      const m = l.trim().split(/\s+/).map(Number);
      if (m.length === 2 && !m.some(isNaN)) {
        if (!kids.has(m[1]))
          kids.set(m[1], []);
        kids.get(m[1]).push(m[0]);
      }
    }
    const out = [root], queue = [root];
    while (queue.length) {
      const p = queue.shift();
      for (const c of kids.get(p) || []) {
        out.push(c);
        queue.push(c);
      }
    }
    return out;
  }
  catch {
    return [root];
  }
}
async function posixStats(root) {
  const pids = await pidTree(root);
  try {
    const res = await pidusage(pids);
    let cpu = 0, memory = 0;
    for (const k of Object.keys(res)) {
      cpu += res[k]?.cpu || 0;
      memory += res[k]?.memory || 0;
    }
    return { cpu, memory };
  }
  catch {
    const { stdout } = await execFileAsync('ps', ['-o', '%cpu=,rss=', '-p', pids.join(',')], { timeout: 5000 });
    let cpu = 0, memory = 0;
    for (const l of stdout.split('\n')) {
      const m = l.trim().split(/\s+/).map(Number);
      if (m.length === 2 && !m.some(isNaN)) {
        cpu += m[0];
        memory += m[1] * 1024;
      }
    }
    return { cpu, memory };
  }
}
// Windows: pidusage использует wmic, которого нет в новых Windows 11 — берём данные через PowerShell/CIM.
let winSnap = null;
const winPrev = new Map();
async function winProcesses() {
  if (winSnap && Date.now() - winSnap.time < 1500)
    return winSnap;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime | ConvertTo-Json -Compress'], { timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  let list = JSON.parse(stdout || '[]');
  if (!Array.isArray(list))
    list = [list];
  winSnap = { time: Date.now(), list };
  return winSnap;
}
async function winStats(root) {
  const snap = await winProcesses();
  const kids = new Map(), byPid = new Map();
  for (const p of snap.list) {
    byPid.set(p.ProcessId, p);
    if (!kids.has(p.ParentProcessId))
      kids.set(p.ParentProcessId, []);
    kids.get(p.ParentProcessId).push(p.ProcessId);
  }
  const seen = new Set([root]), queue = [root];
  let memory = 0, cpuTime = 0;
  while (queue.length) {
    const pid = queue.shift(), p = byPid.get(pid);
    if (p) {
      memory += Number(p.WorkingSetSize) || 0;
      cpuTime += (Number(p.UserModeTime) || 0) + (Number(p.KernelModeTime) || 0);
    }
    for (const c of kids.get(pid) || [])
      if (!seen.has(c)) {
        seen.add(c);
        queue.push(c);
      }
  }
  const prev = winPrev.get(root);
  let cpu = prev?.cpu ?? 0;
  if (!prev || snap.time > prev.time) {
    if (prev)
      cpu = Math.max(0, (cpuTime - prev.cpuTime) / 10000 / (snap.time - prev.time) * 100);
    winPrev.set(root, { time: snap.time, cpuTime, cpu });
  }
  return { cpu, memory };
}
let sysCpu = 0, sysPrev = os.cpus();
setInterval(() => {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = sysPrev[i] || c;
    for (const k in c.times)
      total += c.times[k] - p.times[k];
    idle += c.times.idle - p.times.idle;
  });
  sysPrev = now;
  if (total > 0)
    sysCpu = Math.min(100, Math.max(0, (1 - idle / total) * 100));
}, 2000).unref();


  return { posixStats, winStats, getCpuPercent: () => sysCpu };
};
