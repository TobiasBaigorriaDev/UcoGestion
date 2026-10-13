import { categoryIconNames } from '@uconext/shared';

export function CategoryIcon({ icon, className }: { icon?: string | null | undefined; className?: string | undefined }) {
  const name = categoryIconNames.find(name => name === icon) ?? 'folder';
  return <img src={`/icons/categories/${name}.svg`} alt="" aria-hidden="true" width="24" height="24" className={className} data-category-icon={name} />;
}
