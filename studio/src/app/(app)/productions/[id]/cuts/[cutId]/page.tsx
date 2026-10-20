import { ProductionCutPage } from '@/components/productions/production-cut';
export default async function ProductionCut({ params }: { params: Promise<{ id: string; cutId: string }> }) {
  const { id, cutId } = await params;
  return <ProductionCutPage key={`${id}/${cutId}`} productionId={id} cutId={cutId} />;
}
