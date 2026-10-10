import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../packages/ui/src/tokens.css';
import { CatalogCategoryManagement, loadManagedCategories, type ManagedCategory } from '../../src/features/catalog/catalog-category-management';
import { OnlineOnlyBoundary } from '../../src/offline/online-only-boundary';

const organizationId = new URL(location.href).searchParams.get('organizationId');
if (!organizationId) throw new Error('Missing organization');
function Harness({ organizationId }: { organizationId: string }) {
  const [categories, setCategories] = useState<ManagedCategory[]>([]);
  async function reload() { setCategories(await loadManagedCategories(organizationId)); }
  useEffect(() => { void loadManagedCategories(organizationId).then(setCategories); }, [organizationId]);
  return <OnlineOnlyBoundary><main><CatalogCategoryManagement organizationId={organizationId}
    categories={categories} onReload={() => void reload()} /></main></OnlineOnlyBoundary>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(<Harness organizationId={organizationId} />);
