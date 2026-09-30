/** An icon or shape from the shared sprite (public/assets/sprite.svg). */
export function Icon({ name, className }: { name: string; className?: string }) {
  return (
    <svg className={className} aria-hidden="true">
      <use href={`/assets/sprite.svg#${name}`} />
    </svg>
  );
}
