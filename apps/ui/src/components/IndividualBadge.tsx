/**
 * Pill that displays the recognised individual on a Live observation
 * card. Deterministic colour from the name (HSL hash) so the same cat
 * always has the same colour band; `'unknown'` gets a neutral grey.
 */
export function IndividualBadge({
  name,
  confidence,
}: {
  readonly name: string;
  readonly confidence?: number;
}): preact.JSX.Element {
  const isUnknown = name === 'unknown';
  const color = isUnknown ? '#888' : hashHsl(name);
  return (
    <span
      class={`individual-badge${isUnknown ? ' individual-badge-unknown' : ''}`}
      data-testid="individual-badge"
      style={{
        backgroundColor: color,
        color: '#fff',
      }}
      title={
        confidence !== undefined
          ? `cosine similarity ${confidence.toFixed(3)}`
          : undefined
      }
    >
      {name}
      {confidence !== undefined && !isUnknown && (
        <span class="individual-badge-confidence">
          {Math.round(confidence * 100)}%
        </span>
      )}
    </span>
  );
}

function hashHsl(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}deg 65% 45%)`;
}
