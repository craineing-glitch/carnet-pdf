export const importDate = document => document.importedAt.slice(0, 10);
export function dateGroups(documents) {
  const groups = new Map();
  for (const document of documents) { const date = importDate(document); groups.set(date, (groups.get(date) || 0) + 1); }
  return [...groups].sort(([a],[b])=>b.localeCompare(a)).map(([date,count])=>({date,count}));
}
export function filterDocuments(documents, {categoryId='', date='', query=''}={}) {
  const needle = query.trim().toLocaleLowerCase();
  return documents.filter(document=>(!categoryId||document.categoryId===categoryId)&&(!date||importDate(document)===date)&&(!needle||document.name.toLocaleLowerCase().includes(needle))).sort((a,b)=>b.importedAt.localeCompare(a.importedAt));
}
export function humanSize(bytes) {
  if(bytes<1024)return `${bytes} B`;
  if(bytes<1048576)return `${Math.round(bytes/1024)} KB`;
  return `${Number((bytes/1048576).toFixed(1))} MB`;
}
