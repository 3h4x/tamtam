export function stableHash(str: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % mod;
}

export function nextFireDisplay(schedule: string, agentId: string): string {
  const s = schedule.trim();
  let periodHours = 0;
  if (s.endsWith('h')) {
    periodHours = parseInt(s);
  } else if (s.endsWith('m')) {
    const mins = parseInt(s);
    if (mins >= 60) periodHours = Math.floor(mins / 60);
  }
  if (periodHours < 1) return '';

  const startHour = stableHash(agentId + ':h', periodHours);
  const minOff = stableHash(agentId + ':min', 60);
  const now = new Date();
  const todayBase = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (let h = startHour; h < 24; h += periodHours) {
    const candidate = new Date(todayBase.getTime() + h * 3600000 + minOff * 60000);
    if (candidate > now) {
      const diffMin = Math.round((candidate.getTime() - now.getTime()) / 60000);
      if (diffMin < 60) return `next in ${diffMin}m`;
      return `next in ${Math.floor(diffMin / 60)}h ${diffMin % 60}m`;
    }
  }
  const tomorrowBase = new Date(todayBase.getTime() + 86400000);
  const candidate = new Date(tomorrowBase.getTime() + startHour * 3600000 + minOff * 60000);
  const diffMin = Math.round((candidate.getTime() - now.getTime()) / 60000);
  if (diffMin < 60) return `next in ${diffMin}m`;
  return `next in ${Math.floor(diffMin / 60)}h ${diffMin % 60}m`;
}

export function fireTimesStr(hourPhase: number, cycleHours: number, minute: number): string {
  if (cycleHours <= 1) return `every 1h :${String(minute).padStart(2, '0')}`;
  const hours: number[] = [];
  for (let h = hourPhase; h < 24; h += cycleHours) hours.push(h);
  const times = hours.map((h) => `${h}:${String(minute).padStart(2, '0')}`).join(', ');
  if (times.length > 18) return `every ${cycleHours}h +${hourPhase}h :${String(minute).padStart(2, '0')}`;
  return times;
}
