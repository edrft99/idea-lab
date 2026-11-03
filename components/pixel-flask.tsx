export function PixelFlask() {
  return (
    <svg viewBox="0 0 24 28" aria-hidden="true" shapeRendering="crispEdges">
      <path
        fill="currentColor"
        d="M8 0h8v3h-2v7h2v3h2v3h2v3h2v7h-2v2H4v-2H2v-7h2v-3h2v-3h2v-3h2V3H8z"
      />
      <path fill="var(--pixel-accent)" d="M10 13h4v3h3v3h2v6H5v-6h2v-3h3z" />
      <path fill="var(--pixel-ink)" d="M8 19h3v3H8zm6 3h2v2h-2z" />
    </svg>
  );
}

export function PixelLabScene() {
  return (
    <svg
      className="pixel-lab-scene"
      viewBox="0 0 180 100"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      <path
        fill="var(--pixel-grid)"
        d="M0 88h180v4H0zM12 24h4v4h-4zm140-12h4v4h-4zM26 64h4v4h-4zM164 52h4v4h-4zM40 8h4v4h-4z"
      />
      <path
        fill="var(--pixel-ink)"
        d="M70 8h32v8h-8v24h8v8h8v8h8v8h8v20h-8v8H54v-8h-8V64h8v-8h8v-8h8v-8h8V16h-8z"
      />
      <path
        fill="var(--surface)"
        d="M86 16h0v32h-8v8h-8v8h-8v8h-8v12h64V72h-8v-8h-8v-8h-8v-8h-8z"
      />
      <path fill="var(--pixel-accent)" d="M70 64h32v8h8v12H62V72h8z" />
      <path fill="var(--pixel-ink)" d="M74 72h6v6h-6zm20 6h4v4h-4z" />
      <path
        fill="var(--pixel-purple)"
        d="M118 18h8v-8h4v8h8v4h-8v8h-4v-8h-8zM26 42h8v-8h4v8h8v4h-8v8h-4v-8h-8z"
      />
      <path fill="var(--pixel-accent)" d="M142 66h10v10h-10zM50 20h6v6h-6z" />
    </svg>
  );
}
