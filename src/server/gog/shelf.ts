import { endpoints, gogRequest } from './client';

export async function accountShelfIds(request: (url: string) => Promise<unknown> = gogRequest): Promise<string[]> {
  const ids = new Set<string>();
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const url = new URL(`${endpoints.embed}/account/getFilteredProducts`);
    url.search = new URLSearchParams({ hiddenFlag: '0', isUpdated: '0', mediaType: '1', sortBy: 'title', system: '', page: String(page) }).toString();
    const response = await request(url.toString()) as { products?: unknown; page?: unknown; totalPages?: unknown } | null;
    if (!response || !Array.isArray(response.products) || response.page !== page ||
      !Number.isInteger(response.totalPages) || Number(response.totalPages) < 0 || Number(response.totalPages) > 10000 ||
      (page > 1 && response.totalPages !== totalPages) || (response.totalPages === 0 && response.products.length))
      throw new Error('GOG account shelf response is incomplete or invalid');
    totalPages = Number(response.totalPages);
    for (const product of response.products) {
      const id = String(product?.id ?? '');
      if (!/^\d+$/.test(id)) throw new Error('GOG account shelf contains an invalid product ID');
      ids.add(id);
    }
  }
  return [...ids];
}