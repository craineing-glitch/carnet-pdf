export const importDate = document => document.importedAt.slice(0, 10);
export function dateGroups(documents) {
  const groups = new Map();
  for (const document of documents) { const date = importDate(document); groups.set(date, (groups.get(date) || 0) + 1); }
  return [...groups].sort(([a],[b])=>b.localeCompare(a)).map(([date,count])=>({date,count}));
}
const names = new Intl.Collator('zh-CN', {numeric:true,sensitivity:'base'});
export function sortDocuments(documents, {sort='newest',order=[]}={}) {
  const newest=(a,b)=>b.importedAt.localeCompare(a.importedAt);
  const positions=new Map(order.map((id,index)=>[id,index]));
  return [...documents].sort((a,b)=>{
    if(sort==='oldest')return -newest(a,b);
    if(sort==='name-asc')return names.compare(a.name,b.name);
    if(sort==='name-desc')return names.compare(b.name,a.name);
    if(sort==='manual') {
      const left=positions.get(a.id),right=positions.get(b.id);
      if(left===undefined&&right===undefined)return newest(a,b);
      if(left===undefined)return -1;
      if(right===undefined)return 1;
      return left-right;
    }
    return newest(a,b);
  });
}
export function filterDocuments(documents, {categoryId='', date='', query='',sort='newest',order=[]}={}) {
  const needle = query.trim().toLocaleLowerCase();
  return sortDocuments(documents.filter(document=>(!categoryId||document.categoryId===categoryId)&&(!date||importDate(document)===date)&&(!needle||document.name.toLocaleLowerCase().includes(needle))),{sort,order});
}
export function humanSize(bytes) {
  if(bytes<1024)return `${bytes} B`;
  if(bytes<1048576)return `${Math.round(bytes/1024)} KB`;
  return `${Number((bytes/1048576).toFixed(1))} MB`;
}
