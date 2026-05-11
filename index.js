const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// --- CARREGAMENTO DO .ENV (ROBUSTO) ---
let envLog = "";
function loadEnv() {
    const paths = [
        path.join(process.cwd(), '.env'),
        path.join(path.dirname(process.execPath), '.env'),
        path.join(process.resourcesPath, '.env'),
        path.join(__dirname, '.env')
    ];

    for (const p of paths) {
        if (fs.existsSync(p)) {
            require('dotenv').config({ path: p });
            envLog = p;
            return p;
        }
    }
    return null;
}

loadEnv();

// CONFIGURAÇÃO DINÂMICA
const getApiKey = () => (process.env.OPENROUTESERVICE_API_KEY || '').trim();
const getTaxasUrl = () => (process.env.TAXAS_API_URL || 'https://protein-prep.lovable.app/api/public/taxas-bairros').trim().replace(/[`"']/g, '');
const getHorariosUrl = () => (process.env.HORARIOS_API_URL || 'https://protein-prep.lovable.app/api/public/horarios-funcionamento').trim().replace(/[`"']/g, '');
const getRestauranteCoords = () => ({
    lat: parseFloat(process.env.RESTAURANTE_LAT) || -22.469000,
    lng: parseFloat(process.env.RESTAURANTE_LNG) || -44.457750
});

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const natural = require('natural');
const express = require('express');
const qr = require('qr-image');

// --- CONFIGURAÇÃO DE PASTAS E ESTADO GLOBAL ---
const userDataPath = app.getPath('userData');
const authPath = path.join(userDataPath, '.wwebjs_auth');
const cachePath = path.join(userDataPath, '.wwebjs_cache');
const contactsFilePath = path.join(userDataPath, 'contatos.json');

let botAtivo = true;
let botModoSimplificado = false; 

// Gerenciador de Logs 
let systemLogs = [];
function logSystem(message, type = 'info') {
    const logEntry = { timestamp: new Date().toLocaleTimeString(), message, type };
    systemLogs.push(logEntry);
    if (systemLogs.length > 50) systemLogs.shift();
    console.log(`[${logEntry.timestamp}] [${type.toUpperCase()}] ${message}`);
    if (mainWindow) mainWindow.webContents.send('system-log', logEntry);
}

let dbContatos = {};
if (fs.existsSync(contactsFilePath)) {
    try { dbContatos = JSON.parse(fs.readFileSync(contactsFilePath, 'utf-8')); } 
    catch (err) { console.error('Erro ao ler contatos:', err.message); }
}

function salvarContato(userId, nome) {
    dbContatos[userId] = { ...dbContatos[userId], nome, updatedAt: Date.now() };
    try { fs.writeFileSync(contactsFilePath, JSON.stringify(dbContatos, null, 2)); } 
    catch (err) { console.error('Erro ao salvar contato:', err.message); }
}

function salvarEndereco(userId, endereco) {
    dbContatos[userId] = { ...dbContatos[userId], endereco, updatedAt: Date.now() };
    try { fs.writeFileSync(contactsFilePath, JSON.stringify(dbContatos, null, 2)); } 
    catch (err) { console.error('Erro ao salvar endereço:', err.message); }
}

if (fs.existsSync(cachePath)) {
    try { fs.rmSync(cachePath, { recursive: true, force: true }); } 
    catch (err) { console.error('Erro ao limpar cache:', err.message); }
}

// CONFIGURAÇÃO
const CARDAPIO_API_URL = 'https://protein-prep.lovable.app/api/public/cardapio-do-dia';
const TIMEOUT_DURATION = 15 * 60 * 1000; // 15 minutos de inatividade encerra a sessão
const STARTUP_TIME = Math.floor(Date.now() / 1000);

const userSessions = {};
const tokenizer = new natural.WordTokenizer();

const OPCOES_FIXAS = {
    arroz: ["Branco", "Colorido"],
    feijao: ["Carioca", "Preto"],
    acompanhamentos: ["Macarrão", "Farofa", "Salada do dia"]
};

// --- CACHE E LÓGICA DE HORÁRIOS DA API ---
let cacheHorarios = null;
let ultimaAtualizacaoHorarios = 0;
const TTL_HORARIOS = 15 * 1000; 

async function getHorariosFuncionamento() {
    if (cacheHorarios && (Date.now() - ultimaAtualizacaoHorarios < TTL_HORARIOS)) return cacheHorarios;
    try {
        const response = await axios.get(getHorariosUrl(), { timeout: 8000 });
        cacheHorarios = response.data;
        ultimaAtualizacaoHorarios = Date.now();
        return cacheHorarios;
    } catch (error) {
        logSystem('Erro ao buscar horários. Fallback padrão acionado.', 'warn');
        return {
            "0": { ativo: false, abertura: "11:00", fechamento: "14:30" }, "1": { ativo: true, abertura: "11:00", fechamento: "14:30" },
            "2": { ativo: true, abertura: "11:00", fechamento: "14:30" }, "3": { ativo: true, abertura: "11:00", fechamento: "14:30" },
            "4": { ativo: true, abertura: "11:00", fechamento: "14:30" }, "5": { ativo: true, abertura: "11:00", fechamento: "14:30" },
            "6": { ativo: true, abertura: "11:00", fechamento: "14:30" }
        };
    }
}

function timeToDecimal(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return h + (m / 60);
}

function encontrarProximoExpediente(horarios, diaAtual) {
    const nomesDias = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
    for (let i = 1; i <= 7; i++) {
        let proximoDiaIndex = (diaAtual + i) % 7;
        let configDia = horarios[String(proximoDiaIndex)];
        if (configDia && configDia.ativo) {
            let nomeDia = (i === 1) ? "amanhã" : `no(a) ${nomesDias[proximoDiaIndex]}`;
            return { nome: nomeDia, abertura: configDia.abertura };
        }
    }
    return { nome: "em breve", abertura: "11:00" };
}

async function avaliarStatusRestaurante() {
    const horarios = await getHorariosFuncionamento();
    const agora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const diaSemana = agora.getDay();
    const tempoAtual = agora.getHours() + (agora.getMinutes() / 60);

    const configHoje = horarios[String(diaSemana)];
    const proximoAberto = encontrarProximoExpediente(horarios, diaSemana);

    if (!configHoje || !configHoje.ativo) return { status: 'DIA_FECHADO', configHoje, proximoAberto };

    const decAbertura = timeToDecimal(configHoje.abertura);
    const decFechamento = timeToDecimal(configHoje.fechamento);

    if (tempoAtual < decAbertura) return { status: 'ANTES_EXPEDIENTE', configHoje, proximoAberto };
    if (tempoAtual >= decFechamento) return { status: 'DEPOIS_EXPEDIENTE', configHoje, proximoAberto };
    return { status: 'ABERTO', configHoje, proximoAberto };
}

function extrairHorarioAgendamento(text, configDia) {
    const cleanText = text.toLowerCase().trim();
    if (cleanText.includes('meio dia') || cleanText.includes('meio-dia') || cleanText.includes('meiodia')) return '12:00';
    
    const aberturaDec = timeToDecimal(configDia.abertura);
    const fechamentoDec = timeToDecimal(configDia.fechamento);
    
    const match = cleanText.match(/\b(1[0-9]|0?[1-9])\s*[:hH]\s*([0-5][0-9])?\b/);
    if (match) {
        let h = parseInt(match[1]);
        let m = match[2] ? parseInt(match[2]) : 0;
        if (h >= 1 && h <= 5) h += 12; 
        const horaDecimal = h + (m / 60);
        if (horaDecimal < aberturaDec || horaDecimal > fechamentoDec) return { erro: 'fora_horario' };
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    if (/^(1[0-9]|[1-5])$/.test(cleanText)) {
        let h = parseInt(cleanText);
        if (h >= 1 && h <= 5) h += 12;
        if (h < aberturaDec || h > fechamentoDec) return { erro: 'fora_horario' };
        return `${String(h).padStart(2, '0')}:00`;
    }
    return null;
}

// ----------------------------------------------------------------------
// FUNÇÕES NLP E UTILITÁRIOS
function isCancelIntent(text) {
    const tokens = tokenizer.tokenize(text.toLowerCase());
    const cancelWords = ['cancelar', 'parar', 'sair', 'desistir', 'nada', 'tira', 'esquece', 'encerrar', 'limpar'];
    return tokens.some(token => cancelWords.includes(token));
}

function isHumanIntent(text) {
    const cleanText = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return ['atendente', 'humano', 'pessoa', 'falar com', 'chamar alguem', 'chamar atendente'].some(kw => cleanText.includes(kw));
}

function isPositiveIntent(text) {
    const cleanText = text.toLowerCase().trim();
    if (cleanText === '1' || cleanText === 'sim' || cleanText === 's') return true;
    const tokens = tokenizer.tokenize(cleanText);
    const positiveWords = ['sim', 'quero', 'bora', 'manda', 'cardapio', 'menu', 'pode', 'ok', 'confirmar', 'isso', 'beleza', 'perfeito', 'correto'];
    return tokens.some(token => positiveWords.includes(token));
}

function isNegativeIntent(text) {
    const cleanText = text.toLowerCase().trim();
    if (cleanText === '2' || cleanText === 'não' || cleanText === 'nao' || cleanText === 'n') return true;
    const tokens = tokenizer.tokenize(cleanText);
    const negativeWords = ['não', 'nao', 'n', 'errado', 'incorreto', 'refazer', 'mudar'];
    return tokens.some(token => negativeWords.includes(token));
}

function extrairQuantidades(text) {
    let p = 0; let m = 0;
    let cleanText = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const extenso = { 'um': '1', 'uma': '1', 'dois': '2', 'duas': '2', 'tres': '3', 'quatro': '4', 'cinco': '5', 'seis': '6', 'sete': '7', 'oito': '8', 'nove': '9', 'dez': '10' };
    for (let word in extenso) {
        const regex = new RegExp(`\\b${word}\\b`, 'g');
        cleanText = cleanText.replace(regex, extenso[word]);
    }
    cleanText = cleanText.replace(/\b(marmitas?|tamanhos?|tipo|de)\b/g, '');
    const regexP = /(\d+)\s*p\b/g;
    const regexM = /(\d+)\s*m\b/g;
    let match;
    while ((match = regexP.exec(cleanText)) !== null) p += parseInt(match[1]);
    while ((match = regexM.exec(cleanText)) !== null) m += parseInt(match[1]);
    if (text.includes('cada') && cleanText.includes('1')) { if (p === 0) p = 1; if (m === 0) m = 1; }
    return { p, m };
}

function parsePedidoSimplificado(texto, proteinasDisponiveis, bebidasDisponiveis) {
    let t = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    
    let arroz = "Branco";
    if (t.includes("colorido")) arroz = "Colorido";
    
    let feijao = "Carioca";
    if (t.includes("preto")) feijao = "Preto";
    
    let proteinaEncontrada = "Não identificada";
    for (let p of proteinasDisponiveis) {
        let pNorm = p.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (t.includes(pNorm)) {
            proteinaEncontrada = p;
            break;
        } else {
            let palavrasChave = pNorm.split(' ').filter(w => w.length >= 4 || w === 'ovo' || w === 'bife');
            if (palavrasChave.some(w => t.includes(w))) {
                proteinaEncontrada = p;
                break;
            }
        }
    }
    
    let acompanhamentos = [];
    if (t.includes("macarrao") || t.includes("espaguete") || t.includes("massa")) acompanhamentos.push("Macarrão");
    if (t.includes("farofa")) acompanhamentos.push("Farofa");
    if (t.includes("salada") || t.includes("alface")) acompanhamentos.push("Salada do dia");
    if (acompanhamentos.length === 0) acompanhamentos.push("Nenhum");
    
    let bebidaObj = null;
    for (let b of bebidasDisponiveis) {
        let bNorm = b.nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (t.includes(bNorm) || (bNorm.includes("coca") && t.includes("coca")) || (bNorm.includes("guarana") && t.includes("guarana"))) {
            bebidaObj = { nome: b.nome, preco: parseFloat(b.preco) };
            break;
        }
    }
    
    return { arroz, feijao, proteina: proteinaEncontrada, acompanhamentos, bebida: bebidaObj };
}

async function getCardapioRaw() {
    try {
        const response = await axios.get(CARDAPIO_API_URL, { timeout: 10000 });
        return response.data;
    } catch (error) { return []; }
}

function resolverEscolhaUnica(input, lista) {
    const textNormalizado = input.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const tokens = textNormalizado.split(/[\s,e&]+/).filter(t => t.length > 0);
    let escolhasEncontradas = [];
    lista.forEach((item, index) => {
        const numStr = (index + 1).toString();
        const itemNormalizado = item.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (tokens.includes(numStr)) escolhasEncontradas.push(item);
        else if (textNormalizado.includes(itemNormalizado) || itemNormalizado.includes(textNormalizado)) escolhasEncontradas.push(item);
        else {
            const matchParcial = tokens.some(token => token.length > 3 && itemNormalizado.includes(token));
            if (matchParcial) escolhasEncontradas.push(item);
        }
    });
    escolhasEncontradas = [...new Set(escolhasEncontradas)];
    if (escolhasEncontradas.length > 1 || textNormalizado.includes("todos") || textNormalizado.includes("ambos")) return { erro: "multiplo" };
    return escolhasEncontradas.length === 1 ? { valor: escolhasEncontradas[0] } : { erro: "nao_encontrado" };
}

function resolverEscolhaMultipla(input, lista) {
    const text = input.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (text.includes("todos") || text.includes("tudo") || text.includes("os 3")) return lista;
    const escolhidos = [];
    lista.forEach((item, index) => {
        const itemNormalizado = item.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const numStr = (index + 1).toString();
        const regexNum = new RegExp(`\\b${numStr}\\b`);
        const palavrasItem = itemNormalizado.split(' ');
        const encontrouNome = palavrasItem.some(palavra => new RegExp(`\\b${palavra}\\b`).test(text));
        if (regexNum.test(text) || encontrouNome) escolhidos.push(item);
    });
    return escolhidos;
}

function calcularDistanciaKm(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function getGeocoding(cep, numero) {
    try {
        const apiKey = getApiKey();
        const cepLimpo = cep.replace(/\D/g, '');
        if (!apiKey || apiKey === 'sua_chave_aqui') return { erro: 'config_key' };
        
        let viaCepData = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const viaCepResponse = await axios.get(`https://viacep.com.br/ws/${cepLimpo}/json/`, { timeout: 10000 });
                viaCepData = viaCepResponse.data;
                if (viaCepData.erro) return null;
                break;
            } catch (error) {
                if (attempt === 2) return { erro: 'viacep_fail' };
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        if (!viaCepData) return null;

        const coordsRestaurante = getRestauranteCoords();
        const tentativas = [`${viaCepData.logradouro}, ${numero}, ${viaCepData.localidade}, RJ, Brasil`, `${viaCepData.logradouro}, ${viaCepData.localidade}, RJ, Brasil`];
        for (let i = 0; i < tentativas.length; i++) {
            const query = tentativas[i];
            const orsResponse = await axios.get(`https://api.openrouteservice.org/geocode/search`, {
                params: { api_key: apiKey, text: query, size: 10, 'boundary.country': 'BRA', 'focus.point.lat': coordsRestaurante.lat, 'focus.point.lon': coordsRestaurante.lng }, timeout: 10000
            });
            if (orsResponse.data.features && orsResponse.data.features.length > 0) {
                const resultadosRegiao = orsResponse.data.features.filter(f => {
                    const [lng, lat] = f.geometry.coordinates;
                    const distancia = calcularDistanciaKm(coordsRestaurante.lat, coordsRestaurante.lng, lat, lng);
                    const label = (f.properties.label || '').toLowerCase();
                    return distancia < 30 || (label.includes('resende') && label.includes('rj'));
                });
                if (resultadosRegiao.length > 0) {
                    const melhor = resultadosRegiao[0];
                    const [lng, lat] = melhor.geometry.coordinates;
                    return { rua: viaCepData.logradouro, bairro: viaCepData.bairro, cidade: viaCepData.localidade, uf: viaCepData.uf, lat, lng };
                }
            }
        }
        return null;
    } catch (error) { return null; }
}

async function getRouteDuration(targetLat, targetLng) {
    try {
        const apiKey = getApiKey();
        const coords = getRestauranteCoords();
        const response = await axios.post(`https://api.openrouteservice.org/v2/directions/driving-car`, {
            coordinates: [[coords.lng, coords.lat], [targetLng, targetLat]]
        }, { headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' }, timeout: 10000 });
        if (response.data.routes && response.data.routes.length > 0) return Math.ceil(response.data.routes[0].summary.duration / 60);
        return null;
    } catch (error) { return null; }
}

async function getTaxaEntrega(bairro) {
    try {
        const baseUrl = getTaxasUrl();
        const normalizar = (str) => str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, '-');
        const bairroNormalizado = normalizar(bairro);
        const tentativas = [bairroNormalizado, bairroNormalizado.replace(/-(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i, '').replace(/-(\d+)$/, '')];
        for (let i = 0; i < tentativas.length; i++) {
            try {
                const response = await axios.get(`${baseUrl}/${tentativas[i]}`, { timeout: 8000 });
                if (response.data.ativo === false) continue;
                const taxa = response.data.taxa_entrega !== undefined ? response.data.taxa_entrega : response.data.taxa;
                if (taxa !== undefined) return parseFloat(taxa);
            } catch (error) { continue; }
        }
        return null;
    } catch (error) { return null; }
}

async function montarTextoCardapioInicial(nome) {
    const dadosApi = await getCardapioRaw();
    let cardapioTexto = "Poxa vida, não temos opções cadastradas pra hoje ainda!";
    let bebidasTexto = "";
    if (dadosApi && dadosApi.length > 0) {
        const grupoProteinas = dadosApi.find(g => g.grupo === "Proteínas");
        if (grupoProteinas && Array.isArray(grupoProteinas.categorias) && grupoProteinas.categorias.length > 0) {
            cardapioTexto = grupoProteinas.categorias.map(c => {
                const itensArray = Array.isArray(c.itens) ? c.itens : [];
                return `🥩 *${c.categoria || 'Opções'}*\n${itensArray.map(i => `• ${i}`).join("\n")}`;
            }).join("\n\n");
        }
        const grupoBebidas = dadosApi.find(g => g.grupo === "Bebidas");
        if (grupoBebidas && Array.isArray(grupoBebidas.categorias)) {
            let arrBebidas = [];
            grupoBebidas.categorias.forEach(c => {
                const itensArray = Array.isArray(c.itens) ? c.itens : [];
                arrBebidas.push(...itensArray);
            });
            if (arrBebidas.length > 0) {
                bebidasTexto = `🥤 *BEBIDAS:*\n` + arrBebidas.map(b => `• ${b.nome} - R$ ${parseFloat(b.preco).toFixed(2).replace('.', ',')}`).join('\n') + `\n\n`;
            }
        }
    }
    const saudacao = nome ? `Ôba, ${nome}! Bão demais da conta ver ocê! 🤠\n\n` : `Bão demais da conta! 🤠\n\n`;
    return `${saudacao}Hoje nosso cardápio tá que tá um trem bão:\n\n` +
           `🍚 *Arroz:* Branco ou Colorido\n` +
           `🫘 *Feijão:* Carioca ou Preto\n\n` +
           `${cardapioTexto}\n\n` +
           `💰 *NOSSOS PREÇOS (Marmitas):*\n` +
           `🍱 Marmita P - R$ 16,90\n` +
           `🍱 Marmita M - R$ 18,90\n\n` +
           `${bebidasTexto}`;
}

function gerarTextoRecibo(session) {
    let texto = "";
    if (session.horarioAgendado) texto += `⏰ *PEDIDO AGENDADO PARA AS: ${session.horarioAgendado}*\n\n`;
    session.marmitasA_Montar.forEach(m => {
        const precoMarmita = m.tipo === 'P' ? '16,90' : '18,90';
        texto += `🍱 *${m.index}ª Marmita ${m.tipo}* (R$ ${precoMarmita})\n`;
        texto += `• Arroz ${m.arroz.toLowerCase()} e Feijão ${m.feijao.charAt(0).toUpperCase() + m.feijao.slice(1).toLowerCase()}\n`;
        let textoAcomp = m.acompanhamentos.join(', ');
        if (m.acompanhamentos.length === 2) textoAcomp = m.acompanhamentos.join(' e ');
        else if (m.acompanhamentos.length > 2) {
            let arr = [...m.acompanhamentos];
            let last = arr.pop();
            textoAcomp = arr.join(', ') + ' e ' + last;
        }
        texto += `• Acompanhamento: ${textoAcomp}\n`;
        texto += `• Proteína: ${m.proteina}\n`;
        if (m.bebida) texto += `\n• Bebida: ${m.bebida.nome} (R$ ${m.bebida.preco.toFixed(2).replace('.', ',')})\n`;
        texto += `\n`;
    });
    texto += `-----------------------------------------------\n\n`;
    texto += `💰 *Subtotal:* R$ ${session.subtotal.toFixed(2).replace('.', ',')}\n`;
    texto += `🚚 *Entrega:* R$ ${session.taxaEntrega.toFixed(2).replace('.', ',')}\n`;
    texto += `💵 *Total da conta:* R$ ${session.totalPedido.toFixed(2).replace('.', ',')}\n\n`;
    texto += `-----------------------------------------------\n\n`;
    texto += `💳 *Forma de Pagar:* ${session.metodoPagamento}\n`;
    if (session.metodoPagamento === 'Dinheiro' && session.troco && session.troco !== 'Não precisa') {
        let trocoFormatado = session.troco;
        let matchTroco = session.troco.match(/\d+([.,]\d+)?/);
        if (matchTroco) {
            let valorTroco = parseFloat(matchTroco[0].replace(',', '.'));
            if (!isNaN(valorTroco)) trocoFormatado = `R$ ${valorTroco.toFixed(2).replace('.', ',')}`;
        } else if (!session.troco.toLowerCase().includes('r$')) trocoFormatado = `R$ ${session.troco}`;
        texto += `🪙 *Troco pra:* ${trocoFormatado}\n`;
    }
    return texto.trimEnd(); 
}

async function enviarConfirmacaoMarmita(session, replyFunc) {
    const mAtual = session.marmitasA_Montar[session.currentMarmitaIndex];
    let resumoM = `*REVISÃO DA ${mAtual.index}ª MARMITA ${mAtual.tipo}* 🍱\n` +
                  `🍚 Arroz: ${session.order.arroz}\n` +
                  `🫘 Feijão: ${session.order.feijao}\n` +
                  `🥩 Mistura: ${session.order.proteina}\n` +
                  `🥗 Acompanhamentos: ${session.order.acompanhamentos.join(', ')}\n`;
    if (session.order.bebida) resumoM += `🥤 Bebida: ${session.order.bebida.nome} (+ R$ ${session.order.bebida.preco.toFixed(2).replace('.', ',')})\n`;
    resumoM += `\n*Vamos fechar a tampa da ${mAtual.index}ª Marmita ${mAtual.tipo}?*\n1 - SIM (Pode confirmar)\n2 - NÃO (Vamo refazer)`;
    session.step = 'CONFIRMAR_MARMITA';
    await replyFunc(resumoM);
}

async function enviarResumoConfirmacao(session, replyFunc) {
    let resumoFinal = `🧾 *AQUELA CONFERIDA NO PEDIDO*\n\n`;
    resumoFinal += gerarTextoRecibo(session);
    resumoFinal += `\n\n-----------------------------------------------\n\n`;
    resumoFinal += `📍 *Endereço de Entrega:*\n`;
    resumoFinal += `${session.endereco.rua}, Nº ${session.endereco.numero}\n`;
    if (session.endereco.complemento) resumoFinal += `Complemento: ${session.endereco.complemento}\n`;
    const cidadeUF = (session.endereco.cidade && session.endereco.uf) ? ` - ${session.endereco.cidade} - ${session.endereco.uf}` : ' - Resende - RJ';
    resumoFinal += `Bairro: ${session.endereco.bairro}${cidadeUF}\n\n`;
    resumoFinal += `*Posso fechar o pedido pra mandar pra cozinha?*\n1 - Sim\n2 - Não`;
    await replyFunc(resumoFinal);
}

async function iniciarFluxoEndereco(userId, session, replyFunc) {
    const enderecoSalvo = dbContatos[userId]?.endereco;
    if (enderecoSalvo && enderecoSalvo.rua && enderecoSalvo.numero) {
        session.endereco = enderecoSalvo; 
        const endFormatado = `${enderecoSalvo.rua}, Nº ${enderecoSalvo.numero}${enderecoSalvo.complemento ? ' (' + enderecoSalvo.complemento + ')' : ''} - ${enderecoSalvo.bairro}`;
        await replyFunc(`Ô trem bão! Vi aqui que ocê já pediu com a gente antes. A entrega vai ser nesse endereço?\n\n📍 *${endFormatado}*\n\n1 - Sim (Pode mandar pra cá)\n2 - Não (Vou mandar outro CEP)`);
        session.step = 'CONFIRMAR_ENDERECO_SALVO';
    } else {
        await replyFunc('Ô trem bão 😄 Me passa seu *CEP* rapidim só pra eu espiar se a gente entrega nas suas bandas.');
        session.step = 'PEDIR_CEP';
    }
}

async function processarTaxaEntrega(session, replyFunc, userId) {
    await replyFunc('Fazendo as conta da entrega aqui... 🛵');
    const minutos = await getRouteDuration(session.endereco.lat, session.endereco.lng);
    let motivoIndisponivel = "";

    if (minutos !== null && minutos <= 5) {
        session.taxaEntrega = 0;
        await replyFunc('Eita coisa boa! Ocê fica tão pertin de nós que a gente nem vai cobrar a entrega! É por conta da casa 🤠');
    } else {
        const taxa = await getTaxaEntrega(session.endereco.bairro);
        if (taxa === null) motivoIndisponivel = `infelizmente a gente ainda não atende as banda do bairro *${session.endereco.bairro}* 😥`;
        else if (minutos !== null && minutos > 45) motivoIndisponivel = `ocê mora um cadim longe demais pra gente conseguir levar a marmita ainda trincando de quente (vai dar uns ${minutos} min de viagem) 😥`;
        else {
            session.taxaEntrega = taxa;
            await replyFunc(`🚚 A taxa de entrega aí pras suas banda é R$ ${taxa.toFixed(2).replace('.', ',')}`);
        }
    }

    if (motivoIndisponivel) {
        await replyFunc(`Poxa, ${session.nome}, ${motivoIndisponivel}. Por esse motivo, não vamo dar conta de entregar procê hoje. Agradeço demais a procura! 🙏`);
        delete userSessions[userId];
        return;
    }

    await replyFunc('Quer continuar com o pedido, sô?\n1 - Sim\n2 - Não');
    session.step = 'CONTINUAR_POS_ENDERECO';
}


// LÓGICA PRINCIPAL DE FLUXO
async function processMessage(userId, text, rawBody, replyFunc, contactInfo = {}) {
    if (!botAtivo) return;

    if (userSessions[userId] && userSessions[userId].botPausedUntil) {
        if (Date.now() < userSessions[userId].botPausedUntil) return; 
        else delete userSessions[userId]; 
    }

    if (isHumanIntent(text)) {
        if (!userSessions[userId]) userSessions[userId] = {};
        userSessions[userId].botPausedUntil = Date.now() + 15 * 60 * 1000;
        return await replyFunc('Certo sô! Vou chamar um atendente pra falar com ocê. O Mineirinho vai ficar quietinho aqui por 15 minutos pra vocês conversarem, tá bão? 🤠');
    }

    if (isCancelIntent(text) && userSessions[userId]) {
        delete userSessions[userId];
        return await replyFunc('Tranquilo sô, pedido cancelado! Quando a fome bater, é só mandar um "Oi" que a gente arruma uma marmita caprichada procê. 👋');
    }

    if (userSessions[userId] && (Date.now() - userSessions[userId].lastInteraction > TIMEOUT_DURATION)) {
        delete userSessions[userId];
    }

    if (!userSessions[userId]) {
        let nomeCliente = dbContatos[userId]?.nome;
        if (!nomeCliente && contactInfo.pushname) {
            if (!/^[\d\s\-\+]+$/.test(contactInfo.pushname)) {
                nomeCliente = contactInfo.pushname;
                salvarContato(userId, nomeCliente);
            }
        }

        const infoHorario = await avaliarStatusRestaurante();
        const status = infoHorario.status;
        const proxAberto = infoHorario.proximoAberto;

        if (status === 'DIA_FECHADO') {
            return await replyFunc(`Opa, sô! Hoje tamo descansando as panela. 😴 Manda mensagem pra nós ${proxAberto.nome} a partir das ${proxAberto.abertura} pra conferir o cardápio, tá bão? Um abraço!`);
        }
        if (status === 'DEPOIS_EXPEDIENTE') {
            return await replyFunc(`Eita, o expediente de hoje já encerrou, sô! Nossas panela já tão limpinha. 😴 Manda mensagem pra nós ${proxAberto.nome} a partir das ${proxAberto.abertura} pra ver o cardápio novo, tá bão? Um abraço!`);
        }

        userSessions[userId] = {
            step: nomeCliente ? 'AVALIAR_HORARIO_INICIAL' : 'PERGUNTAR_NOME', 
            nome: nomeCliente || '',
            lastInteraction: Date.now(),
            horarioAgendado: null,
            configDia: infoHorario.configHoje, 
            modo: botModoSimplificado ? 'SIMPLIFICADO' : 'COMPLETO', 
            marmitasP: 0, marmitasM: 0,
            marmitasA_Montar: [], currentMarmitaIndex: 0,
            order: {}, proteinasCache: [], bebidasCache: [],
            endereco: {}, taxaEntrega: 0,
            consultaTaxaSomente: false
        };

        if (!nomeCliente) {
            return await replyFunc('Êba! Aqui é o Mineirinho! 🤠 Notei que é sua primeira vez por aqui, sô. Como é que ocê se chama?');
        } else {
            const cardapioBase = await montarTextoCardapioInicial(nomeCliente);
            if (status === 'ANTES_EXPEDIENTE') {
                userSessions[userId].step = 'PERGUNTAR_AGENDAMENTO';
                return await replyFunc(`${cardapioBase}Ó, nossas panela ainda tão esquentando. A gente abre pra entrega de *${infoHorario.configHoje.abertura} às ${infoHorario.configHoje.fechamento}*.\n\nOcê já quer deixar seu pedido *agendado* pra mais tarde?\n\n*(Responda SIM ou NÃO)*`);
            } else {
                userSessions[userId].step = 'ESCOLHA_POS_CARDAPIO';
                return await replyFunc(`${cardapioBase}Gostaria de montar seu pedido agora?\n\n*(Responda SIM ou NÃO)*`);
            }
        }
    } 
    
    const session = userSessions[userId];
    session.lastInteraction = Date.now();
    
    const aberturaStr = session.configDia?.abertura || '11:00';
    const fechamentoStr = session.configDia?.fechamento || '14:30';

    switch (session.step) {
        case 'PERGUNTAR_NOME':
            const nomeInformado = text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
            session.nome = nomeInformado;
            salvarContato(userId, nomeInformado);
            
            const infoStatusAtual = await avaliarStatusRestaurante();
            session.configDia = infoStatusAtual.configHoje;
            const cardapioInicial = await montarTextoCardapioInicial(session.nome);

            if (infoStatusAtual.status === 'ANTES_EXPEDIENTE') {
                session.step = 'PERGUNTAR_AGENDAMENTO';
                await replyFunc(`${cardapioInicial}Ó, nossas panela ainda tão esquentando. A gente abre pra entrega de *${session.configDia.abertura} às ${session.configDia.fechamento}*.\n\nOcê já quer deixar seu pedido *agendado* pra mais tarde?\n\n*(Responda SIM ou NÃO)*`);
            } else {
                session.step = 'ESCOLHA_POS_CARDAPIO';
                await replyFunc(`${cardapioInicial}Gostaria de montar seu pedido agora?\n\n*(Responda SIM ou NÃO)*`);
            }
            break;

        case 'PERGUNTAR_AGENDAMENTO':
            if (isPositiveIntent(text)) {
                session.step = 'INFORMAR_HORARIO';
                await replyFunc(`Fechado! Pra qual horário entre *${aberturaStr} e ${fechamentoStr}* ocê vai querer a entrega, sô? (Ex: 12:30, 13h, meio dia)`);
            } else if (isNegativeIntent(text)) {
                delete userSessions[userId];
                await replyFunc(`Tranquilo sô! Quando for a partir das ${aberturaStr}, ocê dá um grito aqui que a gente monta sua marmita. Até logo! 👋`);
            } else {
                await replyFunc('Ixi, num entendi sô! Quer agendar seu pedido? (Responda *SIM* ou *NÃO*)');
            }
            break;

        case 'INFORMAR_HORARIO':
            const horario = extrairHorarioAgendamento(text, session.configDia);
            if (!horario) {
                return await replyFunc('Ixi, num consegui entender o horário. Fala de um jeitin tipo "12:30", "13h" ou "meio dia", fazendo favor!');
            }
            if (horario.erro === 'fora_horario') {
                return await replyFunc(`Uai sô, a gente só faz as entrega entre *${aberturaStr} e ${fechamentoStr}*. Escolhe um horário nesse intervalo pra eu agendar!`);
            }

            session.horarioAgendadoTemp = horario;
            session.step = 'CONFIRMAR_HORARIO';
            await replyFunc(`Maravilha! Posso agendar sua entrega pra perto das *${horario}* então?\n1 - Sim\n2 - Não (Digitar outro horário)`);
            break;

        case 'CONFIRMAR_HORARIO':
            if (isPositiveIntent(text)) {
                session.horarioAgendado = session.horarioAgendadoTemp;
                await replyFunc('Fechado, sô! Agendadinho! ⏰');
                await iniciarFluxoEndereco(userId, session, replyFunc);
            } else if (isNegativeIntent(text)) {
                session.step = 'INFORMAR_HORARIO';
                await replyFunc(`Sem problema, sô! Pra qual horário ocê quer agendar então? (Entre ${aberturaStr} e ${fechamentoStr})`);
            } else {
                await replyFunc('Responde com *SIM* ou *NÃO*, fazendo o favor.');
            }
            break;

        case 'ESCOLHA_POS_CARDAPIO':
            if (isPositiveIntent(text)) await iniciarFluxoEndereco(userId, session, replyFunc);
            else if (isNegativeIntent(text)) {
                await replyFunc('Sem caô! Quando a barriga roncar é só chamar. 👋');
                delete userSessions[userId];
            } else await replyFunc('Ixi, num entendi sô! Quer montar seu pedido agora? (Responda *SIM* ou *NÃO*)');
            break;

        case 'CONFIRMAR_PEDIDO': 
            if (isPositiveIntent(text)) await iniciarFluxoEndereco(userId, session, replyFunc);
            else if (isNegativeIntent(text)) {
                await replyFunc('Sem caô! Quando a barriga roncar é só chamar. 👋');
                delete userSessions[userId];
            } else await replyFunc('Ixi, num entendi. Responde com *SIM* ou *NÃO*, fazendo favor.');
            break;

        case 'CONFIRMAR_ENDERECO_SALVO':
            if (isPositiveIntent(text)) await processarTaxaEntrega(session, replyFunc, userId);
            else if (isNegativeIntent(text)) {
                session.endereco = {}; 
                await replyFunc('Sem problema! Me fala então qual que é o *CEP* do endereço novo:');
                session.step = 'PEDIR_CEP';
            } else await replyFunc('Ixi, num entendi! A entrega vai ser no endereço que mandei aí em cima? (Responda *SIM* ou *NÃO*)');
            break;

        case 'PEDIR_CEP':
            session.endereco.cep = text;
            await replyFunc('Bão demais! Agora me conta, qual que é o *número* da casa?');
            session.step = 'PEDIR_NUMERO';
            break;

        case 'PEDIR_NUMERO':
            session.endereco.numero = text;
            await replyFunc('E tem algum *complemento* sô? (Tipo Bloco A, Casa 2... se não tiver, é só mandar "Não")');
            session.step = 'PEDIR_COMPLEMENTO';
            break;

        case 'PEDIR_COMPLEMENTO':
            session.endereco.complemento = (text.toLowerCase() === 'não' || text.toLowerCase() === 'nao') ? '' : text;
            await replyFunc('Caçando seu endereço aqui, pera só um cadim... ⏳');
            
            const geo = await getGeocoding(session.endereco.cep, session.endereco.numero);
            
            if (geo && geo.erro) {
                if (geo.erro === 'config_key') await replyFunc('Uai, tive um probleminha técnico (Chave API). Pode me chamar de novo mais tarde?');
                else if (geo.erro === 'viacep_fail') await replyFunc('Vixe Maria, o sistema de busca de CEP deu uma engasgada aqui. Tenta de novo num instantim, fazendo o favor?');
                else await replyFunc('Nossa senhora, meu sistema de mapas deu um tropicão aqui. Tenta de novo num instantim!');
                delete userSessions[userId];
                return;
            }

            if (!geo) {
                await replyFunc('Uai, não consegui achar esse endereço. 😥 Vamos tentar de novo? Qual que é o seu *CEP* mesmo?');
                session.step = 'PEDIR_CEP';
                return;
            }

            session.endereco = { ...session.endereco, ...geo };
            const confirmacaoMsg = `📍 *Achei esse endereço aqui, ó:*\n\nRua: ${geo.rua}\nBairro: ${geo.bairro}\nCidade: ${geo.cidade} - ${geo.uf}\nNúmero: ${session.endereco.numero}\nComplemento: ${session.endereco.complemento || 'Nenhum'}\n\n*Tá certim?*\n1 - Sim\n2 - Não`;
            await replyFunc(confirmacaoMsg);
            session.step = 'CONFIRMAR_ENDERECO';
            break;

        case 'CONFIRMAR_ENDERECO':
            if (isPositiveIntent(text)) {
                salvarEndereco(userId, session.endereco);
                await processarTaxaEntrega(session, replyFunc, userId);
            } else if (isNegativeIntent(text)) {
                await replyFunc('Tranquilo, vamo começar esse endereço de novo. Qual que é o *CEP* procê?');
                session.step = 'PEDIR_CEP';
            } else await replyFunc('Ixi, num entendi! O endereço aí em cima tá certo? (Responda *SIM* ou *NÃO*)');
            break;

        case 'CONTINUAR_POS_ENDERECO':
            if (isPositiveIntent(text)) {
                await replyFunc('Ô trem bão! Quantas *Marmitas P* (R$ 16,90) e *Marmitas M* (R$ 18,90) ocê vai querer?\n\nPode escrever do seu jeitin mesmo, ex: *"1P e 2M"* ou *"duas P"*');
                session.step = 'DEFINIR_QUANTIDADES';
            } else if (isNegativeIntent(text)) {
                await replyFunc('Tudo bem sô! Agradeço demais a procura. Quando a fome bater é só chamar! 👋');
                delete userSessions[userId];
            } else await replyFunc('Responde com *SIM* ou *NÃO*, fazendo favor. Quer continuar com o pedido?');
            break;

        case 'DEFINIR_QUANTIDADES':
            const qtds = extrairQuantidades(text);
            session.marmitasP = qtds.p; session.marmitasM = qtds.m;
            if (session.marmitasP === 0 && session.marmitasM === 0) {
                return await replyFunc('Uai, não consegui entender as quantidade. 😅 Tenta escrever algo tipo *"1 P"* ou *"2 M"*');
            }
            session.marmitasA_Montar = [];
            for (let i = 1; i <= session.marmitasP; i++) session.marmitasA_Montar.push({ tipo: 'P', index: i });
            for (let i = 1; i <= session.marmitasM; i++) session.marmitasA_Montar.push({ tipo: 'M', index: i });
            session.currentMarmitaIndex = 0;
            const m = session.marmitasA_Montar[0];
            
            let resumoQtds = [];
            if (session.marmitasP > 0) resumoQtds.push(`${session.marmitasP} Marmita${session.marmitasP > 1 ? 's' : ''} P`);
            if (session.marmitasM > 0) resumoQtds.push(`${session.marmitasM} Marmita${session.marmitasM > 1 ? 's' : ''} M`);
            const resumoTexto = resumoQtds.join(' e ');

            if (session.modo === 'SIMPLIFICADO') {
                const dadosCardapioS = await getCardapioRaw();
                let proteinasS = []; let bebidasS = [];
                if (dadosCardapioS && dadosCardapioS.length > 0) {
                    const gProt = dadosCardapioS.find(g => g.grupo === "Proteínas");
                    if (gProt && Array.isArray(gProt.categorias)) {
                        gProt.categorias.forEach(c => { const itensArray = Array.isArray(c.itens) ? c.itens : []; proteinasS.push(...itensArray); });
                    }
                    const gBeb = dadosCardapioS.find(g => g.grupo === "Bebidas");
                    if (gBeb && Array.isArray(gBeb.categorias)) {
                        gBeb.categorias.forEach(c => { const itensArray = Array.isArray(c.itens) ? c.itens : []; bebidasS.push(...itensArray); });
                    }
                }
                session.proteinasCache = proteinasS;
                session.bebidasCache = bebidasS;

                const textoMisturas = proteinasS.length > 0 ? proteinasS.join(', ') : 'Consulte o cardápio acima';
                const exMistura = proteinasS.length > 0 ? proteinasS[0] : 'bife'; 

                let msgSimples = `Fechado sô! Vão ser ${resumoTexto}. ✅\n\n`;
                msgSimples += `Bora montar a *${m.index}ª Marmita ${m.tipo}*. Manda TUDO que ocê quer nela numa *mensagem só*!\n\n`;
                msgSimples += `Pra ocê não precisar subir a tela, lembre que temos:\n`;
                msgSimples += `🥩 *Misturas:* ${textoMisturas}\n`;
                msgSimples += `🥗 *Acompanhamentos:* Macarrão, Farofa e Salada\n\n`;
                msgSimples += `*(Ex: Quero arroz branco, feijão preto, ${exMistura}, farofa, salada e uma coca)*`;

                await replyFunc(msgSimples);
                session.step = 'RECEBER_PEDIDO_SIMPLIFICADO';

            } else {
                await replyFunc(`Fechado sô! Vão ser ${resumoTexto}. ✅\n\nBora montar a *${m.index}ª Marmita ${m.tipo}*.\n\nQual tipo de *Arroz* ocê prefere?\n1 - Branco\n2 - Colorido`);
                session.step = 'MONTAR_ARROZ';
            }
            break;

        case 'RECEBER_PEDIDO_SIMPLIFICADO': {
            const mSimples = session.marmitasA_Montar[session.currentMarmitaIndex];
            const pedidoParseado = parsePedidoSimplificado(text, session.proteinasCache, session.bebidasCache);
            session.order = pedidoParseado;
            
            let msgRevisao = `*Vê se eu entendi direito sua ${mSimples.index}ª Marmita ${mSimples.tipo}:*\n` +
                             `🍚 Arroz: ${pedidoParseado.arroz}\n` +
                             `🫘 Feijão: ${pedidoParseado.feijao}\n` +
                             `🥩 Mistura: ${pedidoParseado.proteina}\n` +
                             `🥗 Acomp.: ${pedidoParseado.acompanhamentos.join(', ')}\n`;
            if (pedidoParseado.bebida) {
                msgRevisao += `🥤 Bebida: ${pedidoParseado.bebida.nome} (+ R$ ${pedidoParseado.bebida.preco.toFixed(2).replace('.', ',')})\n`;
            }
            
            if (pedidoParseado.proteina === "Não identificada") {
                const textoMisturas = session.proteinasCache.join(', ');
                msgRevisao += `\n⚠️ *Ixi, num consegui achar a mistura! Lembre que hoje nossas opções são: ${textoMisturas}*`;
            }
            
            msgRevisao += `\n\nTá certinho pra gente fechar a tampa dela?\n1 - Sim (Pode confirmar)\n2 - Não (Vou escrever de novo)`;
            session.step = 'CONFIRMAR_MARMITA_SIMPLIFICADA';
            await replyFunc(msgRevisao);
            break;
        }

        case 'CONFIRMAR_MARMITA_SIMPLIFICADA': {
            if (isPositiveIntent(text)) {
                if (session.order.proteina === "Não identificada") {
                    const textoMisturas = session.proteinasCache.join(', ');
                    await replyFunc(`Uai sô, não posso fechar a marmita sem a mistura! Hoje a gente tem: *${textoMisturas}*.\n\nEscreve de novo pra mim, fazendo favor, tudo que ocê quer nessa marmita:`);
                    session.step = 'RECEBER_PEDIDO_SIMPLIFICADO';
                    return;
                }
                
                const mFinalizada = session.marmitasA_Montar[session.currentMarmitaIndex];
                Object.assign(mFinalizada, session.order);
                session.currentMarmitaIndex++; 
                session.order = {}; 
                
                if (session.currentMarmitaIndex < session.marmitasA_Montar.length) {
                    const proxima = session.marmitasA_Montar[session.currentMarmitaIndex];
                    await replyFunc(`Marmita no capricho! ✅\n\nAgora manda numa *mensagem só* o que ocê quer na *${proxima.index}ª Marmita ${proxima.tipo}*:`);
                    session.step = 'RECEBER_PEDIDO_SIMPLIFICADO';
                } else {
                    let subtotalMarmitas = (session.marmitasP * 16.9) + (session.marmitasM * 18.9);
                    let subtotalBebidas = 0;
                    session.marmitasA_Montar.forEach(m => { if (m.bebida) subtotalBebidas += m.bebida.preco; });
                    session.subtotal = subtotalMarmitas + subtotalBebidas;
                    session.totalPedido = session.subtotal + session.taxaEntrega;

                    const totalFormatado = session.totalPedido.toFixed(2).replace('.', ',');
                    await replyFunc(`Tudo anotadim sô! 📝\nO total da sua conta ficou em *R$ ${totalFormatado}* (já com a entrega).\n\nPra gente despachar seu pedido, como que ocê vai pagar?\n\n1 - Cartão\n2 - Dinheiro\n3 - PIX`);
                    session.step = 'ESCOLHER_PAGAMENTO';
                }
            } else if (isNegativeIntent(text)) {
                await replyFunc("Eita, escreve de novo então, bem explicadin pra mim o que vai na marmita:");
                session.step = 'RECEBER_PEDIDO_SIMPLIFICADO';
            } else {
                await replyFunc('Responde com *SIM* ou *NÃO*, sô!');
            }
            break;
        }

        case 'MONTAR_ARROZ':
            const resArroz = resolverEscolhaUnica(text, OPCOES_FIXAS.arroz);
            if (resArroz.erro === "multiplo") return await replyFunc("Uai, dessa vez a marmita só aceita 1 tipo de arroz. Qual que ocê quer?\n1 - Branco\n2 - Colorido");
            if (resArroz.erro === "nao_encontrado") return await replyFunc("Opa! Escolhe uma dessas aqui sô:\n1 - Branco\n2 - Colorido");
            session.order.arroz = resArroz.valor;
            await replyFunc(`Tá na mão! E de *Feijão*?\n1 - Carioca\n2 - Preto`);
            session.step = 'MONTAR_FEIJAO';
            break;

        case 'MONTAR_FEIJAO':
            const resFeijao = resolverEscolhaUnica(text, OPCOES_FIXAS.feijao);
            if (resFeijao.erro === "multiplo") return await replyFunc("Uai, dessa vez a marmita só aceita 1 tipo de feijão. Qual que ocê quer?\n1 - Carioca\n2 - Preto");
            if (resFeijao.erro === "nao_encontrado") return await replyFunc("Opa! Escolhe uma dessas aqui sô:\n1 - Carioca\n2 - Preto");
            session.order.feijao = resFeijao.valor;
            
            const dadosCardapio = await getCardapioRaw();
            let proteinas = []; let listaTexto = "Agora o principal, escolhe a *Mistura (Proteína)*:\n"; let count = 1;
            
            if (dadosCardapio && dadosCardapio.length > 0) {
                const grupoProteinas = dadosCardapio.find(g => g.grupo === "Proteínas");
                if (grupoProteinas && Array.isArray(grupoProteinas.categorias)) {
                    grupoProteinas.categorias.forEach(c => {
                        listaTexto += `\n*${c.categoria || 'Opções'}*\n`;
                        const itensArray = Array.isArray(c.itens) ? c.itens : [];
                        itensArray.forEach(item => { listaTexto += `${count} - ${item}\n`; proteinas.push(item); count++; });
                    });
                }
            }

            if (proteinas.length === 0) return await replyFunc("Vixe Maria, parece que o fogão escondeu as mistura hoje! Num achei as proteínas cadastradas. Desculpa qualquer coisa e muito obrigado! 🙏");
            session.proteinasCache = proteinas;
            await replyFunc(listaTexto);
            session.step = 'MONTAR_PROTEINA';
            break;

        case 'MONTAR_PROTEINA':
            const resProt = resolverEscolhaUnica(text, session.proteinasCache);
            if (resProt.erro === "multiplo") return await replyFunc("Uai, ocê só pode escolher 1 mistura por marmita. Qual vai ser?");
            if (resProt.erro === "nao_encontrado") return await replyFunc("Uai, escolhe uma opção ou número aí dessa lista!");
            session.order.proteina = resProt.valor;
            await replyFunc('Escolha da boa sô! 🥩\n\nVai querer os acompanhamentos? (Ocê pode escolher o que quiser! Só mandar os número ou falar "Todos")\n1 - Macarrão\n2 - Farofa\n3 - Salada do dia\n\n*(Ou só fala "Não")*');
            session.step = 'MONTAR_ACOMPANHAMENTOS';
            break;

        case 'MONTAR_ACOMPANHAMENTOS': {
            if (text.includes('não') || text.includes('nao') || text.includes('nada')) session.order.acompanhamentos = ['Nenhum'];
            else {
                const escolhidos = resolverEscolhaMultipla(text, OPCOES_FIXAS.acompanhamentos);
                session.order.acompanhamentos = escolhidos.length > 0 ? escolhidos : ['Nenhum'];
            }
            
            const dadosMenu = await getCardapioRaw();
            let bebidasDoDia = [];
            if (dadosMenu && dadosMenu.length > 0) {
                const grupoBebidas = dadosMenu.find(g => g.grupo === "Bebidas");
                if (grupoBebidas && Array.isArray(grupoBebidas.categorias)) {
                    grupoBebidas.categorias.forEach(c => { const itensArray = Array.isArray(c.itens) ? c.itens : []; bebidasDoDia.push(...itensArray); });
                }
            }

            if (bebidasDoDia.length === 0) {
                await replyFunc('Tudo na panela! 🥗\n\nVixe, hoje faltou bebida no cardápio! Vou pular direto pra revisão da marmita, tá bão?');
                session.order.bebida = null;
                return await enviarConfirmacaoMarmita(session, replyFunc);
            }

            session.bebidasCache = bebidasDoDia;
            let msgBebida = 'Tudo na panela! 🥗\n\nPra molhar a palavra, vai querer bebida? Temos:\n\n';
            bebidasDoDia.forEach((b, i) => { msgBebida += `${i + 1} - ${b.nome} (R$ ${parseFloat(b.preco).toFixed(2).replace('.', ',')})\n`; });
            msgBebida += `\n0 - Não quero bebida`;
            await replyFunc(msgBebida);
            session.step = 'ESCOLHER_BEBIDA_FINAL';
            break;
        }

        case 'ESCOLHER_BEBIDA_FINAL': {
            const cleanT = text.toLowerCase().trim();
            if (cleanT === '0' || cleanT === 'nao' || cleanT === 'não' || cleanT === 'nada' || isCancelIntent(cleanT)) session.order.bebida = null;
            else {
                const nomesBebidas = session.bebidasCache.map(b => b.nome);
                const resBebida = resolverEscolhaUnica(text, nomesBebidas);
                if (resBebida.erro === "multiplo") return await replyFunc("Uai, escolhe só uma bebida pra essa marmita sô. Qual vai ser?");
                if (resBebida.erro === "nao_encontrado") return await replyFunc("Opa! Escolhe um número aí da lista (Ou digite 0 se não quiser)!");
                const bebidaMapeada = session.bebidasCache.find(b => b.nome === resBebida.valor);
                session.order.bebida = { nome: bebidaMapeada.nome, preco: parseFloat(bebidaMapeada.preco) };
            }
            await enviarConfirmacaoMarmita(session, replyFunc);
            break;
        }

        case 'CONFIRMAR_MARMITA': {
            if (isPositiveIntent(text)) {
                const mFinalizada = session.marmitasA_Montar[session.currentMarmitaIndex];
                Object.assign(mFinalizada, session.order);
                session.currentMarmitaIndex++; session.order = {}; 
                
                if (session.currentMarmitaIndex < session.marmitasA_Montar.length) {
                    const proxima = session.marmitasA_Montar[session.currentMarmitaIndex];
                    await replyFunc(`Marmita no capricho! ✅\n\nAgora, simbora montar a *${proxima.index}ª Marmita ${proxima.tipo}*.\n\nQual tipo de *Arroz* ocê prefere?\n1 - Branco\n2 - Colorido`);
                    session.step = 'MONTAR_ARROZ';
                } else {
                    let subtotalMarmitas = (session.marmitasP * 16.9) + (session.marmitasM * 18.9);
                    let subtotalBebidas = 0;
                    session.marmitasA_Montar.forEach(m => { if (m.bebida) subtotalBebidas += m.bebida.preco; });
                    session.subtotal = subtotalMarmitas + subtotalBebidas;
                    session.totalPedido = session.subtotal + session.taxaEntrega;

                    const totalFormatado = session.totalPedido.toFixed(2).replace('.', ',');
                    await replyFunc(`Tudo anotadim sô! 📝\nO total da sua conta ficou em *R$ ${totalFormatado}* (já com a entrega).\n\nPra gente despachar seu pedido, como que ocê vai pagar?\n\n1 - Cartão\n2 - Dinheiro\n3 - PIX`);
                    session.step = 'ESCOLHER_PAGAMENTO';
                }
            } else if (isNegativeIntent(text)) {
                const mRefazer = session.marmitasA_Montar[session.currentMarmitaIndex];
                await replyFunc(`Sem caô, a gente desmancha e refaz a *${mRefazer.index}ª Marmita ${mRefazer.tipo}*.\n\nQual tipo de *Arroz* ocê prefere?\n1 - Branco\n2 - Colorido`);
                session.order = {}; session.step = 'MONTAR_ARROZ';
            } else await replyFunc('Eita, num entendi. Manda um *SIM* pra confirmar a marmita ou *NÃO* pra gente refazer.');
            break;
        }

        case 'ESCOLHER_PAGAMENTO':
            if (text === '1' || text.toLowerCase().includes('cartão') || text.toLowerCase().includes('cartao')) {
                session.metodoPagamento = 'Cartão';
                await enviarResumoConfirmacao(session, replyFunc);
                session.step = 'CONFIRMAR_ENVIO_COZINHA';
            } else if (text === '2' || text.toLowerCase().includes('dinheiro')) {
                session.metodoPagamento = 'Dinheiro';
                await replyFunc('Ocê vai precisar de troco pra quanto? (Se tiver trocadim, é só mandar "Não")');
                session.step = 'PERGUNTAR_TROCO';
            } else if (text === '3' || text.toLowerCase().includes('pix')) {
                session.metodoPagamento = 'PIX';
                await enviarResumoConfirmacao(session, replyFunc);
                session.step = 'CONFIRMAR_ENVIO_COZINHA';
            } else await replyFunc('Escolhe uma das opções sô:\n1 - Cartão\n2 - Dinheiro\n3 - PIX');
            break;

        case 'PERGUNTAR_TROCO':
            session.troco = (text.toLowerCase() === 'não' || text.toLowerCase() === 'nao') ? 'Não precisa' : text;
            await enviarResumoConfirmacao(session, replyFunc);
            session.step = 'CONFIRMAR_ENVIO_COZINHA';
            break;
            
        case 'CONFIRMAR_ENVIO_COZINHA':
            if (isPositiveIntent(text)) {
                let msgFinal = `✅ *Tudo nos conformes, sô! O Mineirinho já passou o pedido pro fogão.* 🤠\n\nSeu Pedido ficou assim:\n\n`;
                msgFinal += gerarTextoRecibo(session);
                msgFinal += `\n\n-----------------------------------------------\n\n📍 *Endereço de Entrega:*\n\n${session.endereco.rua}, Nº ${session.endereco.numero}\n\n`;
                if (session.endereco.complemento) msgFinal += `Complemento: ${session.endereco.complemento}\n\n`;
                const cidadeUF = (session.endereco.cidade && session.endereco.uf) ? ` - ${session.endereco.cidade} - ${session.endereco.uf}` : ' - Resende - RJ';
                msgFinal += `Bairro: ${session.endereco.bairro}${cidadeUF}`;
                
                if (session.metodoPagamento === 'PIX') {
                    msgFinal += `\n\n-----------------------------------------------\n\n📲 *Chave PIX:* 65.448.226/0001-03\n\n*(Assim que transferir, manda a foto ou o arquivo do comprovante aqui pra nós confirmarmos e enviarmos pra cozinha, fazendo favor)* 📸`;
                    await replyFunc(msgFinal);
                    session.step = 'AGUARDAR_COMPROVANTE';
                } else {
                    msgFinal += `\n\n*A Estância Mineira te agradece demais da conta pela preferência! Um abração!*`;
                    await replyFunc(msgFinal);
                    delete userSessions[userId];
                }
            } else if (isNegativeIntent(text)) {
                await replyFunc('Tranquilo sô, não vamo fechar o pedido não. Se quiser começar de novo, é só mandar um "Oi". 👋');
                delete userSessions[userId];
            } else await replyFunc('Ixi, num entendi. *Posso fechar o pedido pra mandar pra cozinha?* Responde com *SIM* ou *NÃO*.');
            break;

        case 'AGUARDAR_COMPROVANTE':
            const keywordsConf = ['ok', 'mandei', 'ta ai', 'tá ai', 'tá aí', 'pronto', 'enviei', 'feito'];
            if (contactInfo.hasMedia || keywordsConf.some(kw => text.includes(kw)) || isPositiveIntent(text)) {
                await replyFunc('Comprovante recebido com sucesso, sô! Muito obrigado pela preferência. Seu pedido já tá no fogo! 🔥🤠');
                delete userSessions[userId];
            } else {
                await replyFunc('Tô aguardando a foto ou arquivo do comprovante do PIX pra liberar seu pedido pra cozinha, sô! 📸 (Se já enviou, só me manda um "ok")');
            }
            break;
    }
}

// --- CONFIGURAÇÃO DO ELECTRON E EXPRESS ---
let mainWindow;
let conectado = false;
let lastQrBase64 = null; 

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900, height: 850, autoHideMenuBar: true,
        webPreferences: { 
            nodeIntegration: true,      // REATIVADO: Permite que o Front-end renderize o QR e os logs
            contextIsolation: false     // REATIVADO: Comunicação direta com o backend
        }
    });
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.on('closed', () => { mainWindow = null; });
}

const serverApp = express();

serverApp.use(express.json({ limit: '1mb' })); 
serverApp.disable('x-powered-by');

serverApp.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
});

serverApp.use(express.static(path.join(__dirname, 'public')));
serverApp.use(express.static(path.join(__dirname, 'web')));

serverApp.post('/toggle-bot', (req, res) => {
    botAtivo = req.body.ativo;
    logSystem(`Robô foi ${botAtivo ? 'ATIVADO' : 'DESATIVADO'} pelo painel.`, botAtivo ? 'info' : 'warn');
    res.json({ success: true, botAtivo });
});

serverApp.post('/toggle-mode', (req, res) => {
    botModoSimplificado = req.body.simplificado;
    logSystem(`Modo de pedido alterado para: ${botModoSimplificado ? 'SIMPLIFICADO' : 'COMPLETO'}.`, 'info');
    res.json({ success: true, modoSimplificado: botModoSimplificado });
});

serverApp.get('/status', (req, res) => {
    res.json({ connected: conectado, qr: lastQrBase64, botAtivo: botAtivo, modoSimplificado: botModoSimplificado });
});

serverApp.get('/logs', (req, res) => {
    res.json(systemLogs);
});

serverApp.post('/simular', async (req, res) => {
    try {
        const { text } = req.body;
        const replies = []; 
        await processMessage('simulacao-ui', (text || '').toLowerCase().trim(), text || '', 
            async (reply) => { replies.push(reply); }, { pushname: 'Testador', hasMedia: false } 
        );
        res.json({ reply: replies.length > 0 ? replies.join('\n\n---\n\n') : 'O Mineirinho tá pensando...' });
    } catch (err) {
        logSystem(`Erro na simulação: ${err.message}`, 'error');
        res.status(500).json({ reply: 'Vixe Maria, erro na simulação.' });
    }
});

serverApp.listen(3000, () => { console.log('🌐 Servidor Express rodando na porta 3000'); });

// --- BUSCADOR DE NAVEGADOR (CORREÇÃO PARA BUILD COMPILADO) ---
function getChromePath() {
    const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];
    for (let p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return undefined; 
}

const browserPath = getChromePath();
if (browserPath) {
    console.log(`🌐 Navegador do sistema encontrado: ${browserPath}`);
} else {
    console.log('⚠️ Google Chrome não encontrado nos locais padrão. Usando Chromium interno...');
}

// --- CLIENTE WHATSAPP ---
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: {
        executablePath: browserPath, // Usa o Chrome nativo da máquina
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--disable-accelerated-2d-canvas', 
            '--no-first-run', 
            '--no-zygote', 
            '--disable-gpu'
        ]
    }
});

async function sendWithTyping(chat, content) {
    try { await chat.sendStateTyping(); } catch (err) {}
    const delay = Math.min(Math.max(content.length * 30, 800), 2500);
    return new Promise(resolve => {
        setTimeout(async () => {
            try { await chat.clearState(); } catch (err) {}
            await chat.sendMessage(content);
            resolve();
        }, delay);
    });
}

client.on('qr', async qrCode => {
    console.log('📱 Novo QR Code gerado');
    const qrBuffer = qr.imageSync(qrCode, { type: 'png' });
    lastQrBase64 = `data:image/png;base64,${qrBuffer.toString('base64')}`;
});

client.on('ready', () => { conectado = true; lastQrBase64 = null; console.log('✅ Mineirinho conectado!'); });
client.on('disconnected', reason => { conectado = false; console.log('⚠️ Bot desconectado:', reason); });

client.on('message', async msg => {
    try {
        if (msg.timestamp < STARTUP_TIME || msg.fromMe || msg.isGroup || msg.from === 'status@broadcast') return;
        const chat = await msg.getChat();
        const contact = await msg.getContact();
        
        await processMessage(msg.from, msg.body.toLowerCase().trim(), msg.body, 
            async (response) => { await sendWithTyping(chat, response); }, 
            { pushname: contact.pushname, hasMedia: msg.hasMedia }
        );
    } catch (err) { console.log('Erro:', err.message); }
});

app.whenReady().then(() => {
    logSystem('--- APLICAÇÃO INICIADA ---');
    logSystem(`Caminho de dados: ${userDataPath}`);
    logSystem(`Caminho do .env carregado: ${envLog || 'NÃO ENCONTRADO'}`);
    createWindow();
    client.initialize();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });
process.on('unhandledRejection', err => { console.log('Promise rejeitada:', err?.message); });
process.on('uncaughtException', err => { console.log('Erro geral:', err?.message); });