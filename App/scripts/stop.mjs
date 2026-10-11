const url=`http://127.0.0.1:${Number(process.env.PORT||4328)}`;
try{
  const session=await fetch(url+'/api/session',{signal:AbortSignal.timeout(1500)}).then(r=>r.json());
  if(session.app!=='carnet-pdf-reader')throw new Error('该端口上的程序不是 Carnet PDF，未执行关闭。');
  const result=await fetch(url+'/api/shutdown',{method:'POST',headers:{'x-carnet-token':session.token},signal:AbortSignal.timeout(5000)});
  if(!result.ok)throw new Error('关闭失败，请稍后重试。');
  console.log('Carnet PDF 本地服务已停止。现在可以备份或移动整个目录。');
}catch(error){if(error.cause?.code==='ECONNREFUSED')console.log('阅读器已经停止。');else{console.error(error.message);process.exitCode=1;}}
