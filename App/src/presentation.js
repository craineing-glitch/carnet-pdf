export function updateEntryBody(entry,body){
 const next={...entry,body};
 if(entry.titleMode==='auto'||!entry.title?.trim()){
   next.title=Array.from(body.split(/\r?\n/).find(line=>line.trim())?.trim()||'').slice(0,80).join('');next.titleMode='auto';
 }
 return next;
}
export function getPresentation(id){
 if(id==='shinchan')return {mode:'light',text:'#243b30',chrome:'#243b30',panel:'linear-gradient(130deg,rgba(255,250,236,.25),rgba(248,244,227,.23))',surface:'rgba(249,249,237,.32)',control:'rgba(253,250,237,.43)',filter:'blur(6px) saturate(.9) contrast(.85) brightness(1.15)'};
 const dark=['rose-dusk','snow','kyoto','sunset','autumn'].includes(id);
 const text=dark?({snow:'#edf6ff',kyoto:'#f5f7e9',autumn:'#fff3de',sunset:'#fff0e6'}[id]||'#fff2e7'):({paris:'#142b3d',alpine:'#102e32'}[id]||'#10262b');
 return dark?{mode:'dark',text,chrome:text,panel:'linear-gradient(130deg,rgba(22,31,29,.25),rgba(34,30,27,.23))',surface:'rgba(25,34,30,.32)',control:'rgba(29,37,31,.43)',filter:'blur(6px) saturate(.9) contrast(.85) brightness(1.15)'}:
 {mode:'light',text,chrome:text,panel:'linear-gradient(130deg,rgba(255,250,236,.25),rgba(248,244,227,.23))',surface:'rgba(249,249,237,.32)',control:'rgba(253,250,237,.43)',filter:'blur(6px) saturate(.9) contrast(.85) brightness(1.15)'};
}
