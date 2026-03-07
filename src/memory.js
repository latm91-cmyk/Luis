// Optional memory module if you later move memory out of server.js
const memory = new Map();

function memPush(id,role,text){
  const arr = memory.get(id) || [];
  arr.push({role,text});
  while(arr.length > 20) arr.shift();
  memory.set(id,arr);
}

function memGet(id){
  return memory.get(id) || [];
}

module.exports = { memPush, memGet };