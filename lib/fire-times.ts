export function fireTimesStr(hourPhase: number, cycleHours: number, minute: number): string {
  if (cycleHours <= 1) return `every 1h :${String(minute).padStart(2, '0')}`;
  const hours: number[] = [];
  for (let h = hourPhase; h < 24; h += cycleHours) hours.push(h);
  const times = hours.map((h) => `${h}:${String(minute).padStart(2, '0')}`).join(', ');
  if (times.length > 18) return `every ${cycleHours}h +${hourPhase}h :${String(minute).padStart(2, '0')}`;
  return times;
}
