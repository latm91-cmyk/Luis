
const cache = new Map();

function loadBoletas(lista){
  lista.forEach(b=>cache.set(b.boleta,b));
}

function getDisponibles(){
  return Array.from(cache.values()).filter(b=>b.estado==="DISPONIBLE");
}

function updateBoleta(numero,data){
  if(cache.has(numero)){
    Object.assign(cache.get(numero),data);
  }
}

module.exports = { loadBoletas, getDisponibles, updateBoleta };
