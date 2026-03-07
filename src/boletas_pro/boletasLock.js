
const locks = new Map();

function lockBoleta(numero, cliente){
  if(locks.has(numero)) return false;
  locks.set(numero,{cliente,ts:Date.now()});
  return true;
}

function unlockBoleta(numero){
  locks.delete(numero);
}

module.exports = { lockBoleta, unlockBoleta };
