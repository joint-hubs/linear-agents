const API_BASE = import.meta.env.VITE_API_BASE || '';

async function apiFetch(path) {
  const r = await fetch(API_BASE + path);
  if (!r.ok) throw new Error('API ' + r.status);
  return r.json();
}

export async function getRuns() {
  return apiFetch('/api/runs');
}

export async function getRun(id) {
  return apiFetch('/api/runs/' + id);
}

export async function getSummary() {
  return apiFetch('/api/summary');
}

export async function getBudget() {
  return apiFetch('/api/budget');
}
