import type { ComponentChildren, JSX } from 'preact';

export type BannerKind = 'error' | 'warn' | 'info';

export function Banner(props: {
  kind: BannerKind;
  children: ComponentChildren;
  onClose?: () => void;
}): JSX.Element {
  return (
    <div class={`banner banner-${props.kind}`} role="alert">
      <span>{props.children}</span>
      {props.onClose && (
        <button class="banner-close" aria-label="dismiss" onClick={props.onClose}>
          ✕
        </button>
      )}
    </div>
  );
}
