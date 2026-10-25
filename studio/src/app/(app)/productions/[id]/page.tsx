import { ProductionPage } from '@/components/productions/production-page';
export default async function Production({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <ProductionPage key={id} id={id} />; }
