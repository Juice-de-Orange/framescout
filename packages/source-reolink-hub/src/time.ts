/**
 * Reolink Hub time conversion. The Hub serialises timestamps as
 * `{ year, mon, day, hour, min, sec }` integer components in its
 * configured local timezone. v0.1 assumes the Hub is set to UTC; if
 * it isn't, timestamps drift. Configurable timezone support is a v0.2
 * concern (see `docs/sources/reolink-hub.md`).
 */
export interface HubTimeParts {
  year: number;
  mon: number;
  day: number;
  hour: number;
  min: number;
  sec: number;
}

export function hubPartsToDate(parts: HubTimeParts): Date {
  return new Date(
    Date.UTC(parts.year, parts.mon - 1, parts.day, parts.hour, parts.min, parts.sec),
  );
}

export function dateToHubParts(d: Date): HubTimeParts {
  return {
    year: d.getUTCFullYear(),
    mon: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    min: d.getUTCMinutes(),
    sec: d.getUTCSeconds(),
  };
}
