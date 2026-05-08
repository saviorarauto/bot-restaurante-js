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
        path.join(__dirname, '.env') // Fallback para dentro do ASAR
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

let botAtivo = true; // BOTÃO LIGA/DESLIGA GLOBAL

// Gerenciador de Logs para a UI
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
    try {
        dbContatos = JSON.parse(fs.readFileSync(contactsFilePath, 'utf-8'));
    } catch (err) {
        console.error('Erro ao ler contatos:', err.message);
    }
}

function salvarContato(userId, nome) {
    dbContatos[userId] = { nome, updatedAt: Date.now() };
    try {
        fs.writeFileSync(contactsFilePath, JSON.stringify(dbContatos, null, 2));
    } catch (err) {
        console.error('Erro ao salvar contato:', err.message);
    }
}

// --- LIMPEZA DE CACHE AUTOMÁTICA ---
if (fs.existsSync(cachePath)) {
    try {
        fs.rmSync(cachePath, { recursive: true, force: true });
    } catch (err) {
        console.error('Erro ao limpar cache:', err.message);
    }
}

// CONFIGURAÇÃO
const CARDAPIO_API_URL = 'https://protein-prep.lovable.app/api/public/cardapio-do-dia';

const TIMEOUT_DURATION = 30 * 60 * 1000; 
const STARTUP_TIME = Math.floor(Date.now() / 1000);

// Gerenciador de sessões e NLP
const userSessions = {};
const tokenizer = new natural.WordTokenizer();

// OPÇÕES PADRÃO
const OPCOES_FIXAS = {
    arroz: ["Branco", "Colorido"],
    feijao: ["Carioca", "Preto"],
    acompanhamentos: ["Macarrão", "Farofa", "Salada do dia"]
};

// FUNÇÕES NLP
function isCancelIntent(text) {
    const tokens = tokenizer.tokenize(text.toLowerCase());
    const cancelWords = ['cancelar', 'parar', 'sair', 'desistir', 'nada', 'tira', 'esquece', 'encerrar', 'limpar'];
    return tokens.some(token => cancelWords.includes(token));
}

function isHumanIntent(text) {
    const cleanText = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const humanWords = ['atendente', 'humano', 'pessoa', 'falar com', 'chamar alguem', 'chamar atendente'];
    return humanWords.some(kw => cleanText.includes(kw));
}

function isPositiveIntent(text) {
    const cleanText = text.toLowerCase().trim();
    if (cleanText === '1') return true;
    const tokens = tokenizer.tokenize(cleanText);
    const positiveWords = [
        'sim', 'quero', 'bora', 'manda', 'cardapio', 'cardápio', 'menu', 'pode', 'ver', 
        'mostrar', 's', 'ok', 'confirmar', 'confirmo', 'isso', 'com-certeza', 'beleza', 
        'perfeito', 'correto', 'exato', 'opa', 'claro', 'bora', 'mão', 'mao'
    ];
    return tokens.some(token => positiveWords.includes(token)) || cleanText === 'sim' || cleanText === 's';
}

function isNegativeIntent(text) {
    const cleanText = text.toLowerCase().trim();
    if (cleanText === '2') return true;
    const tokens = tokenizer.tokenize(cleanText);
    const negativeWords = [
        'não', 'nao', 'n', 'errado', 'incorreto', 'refazer', 'mudar', 'jamais', 'nunca', 
        'nada-disso', 'pare', 'parar', 'nem-pensar', 'negativo'
    ];
    return tokens.some(token => negativeWords.includes(token)) || cleanText === 'não' || cleanText === 'nao' || cleanText === 'n';
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

    if (text.includes('cada') && cleanText.includes('1')) {
        if (p === 0) p = 1;
        if (m === 0) m = 1;
    }

    return { p, m };
}

async function getCardapioRaw() {
    try {
        const response = await axios.get(CARDAPIO_API_URL, { timeout: 10000 });
        return response.data;
    } catch (error) {
        return [];
    }
}

function resolverEscolhaUnica(input, lista) {
    const textNormalizado = input.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const tokens = textNormalizado.split(/[\s,e&]+/).filter(t => t.length > 0);
    let escolhasEncontradas = [];

    lista.forEach((item, index) => {
        const numStr = (index + 1).toString();
        const itemNormalizado = item.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

        if (tokens.includes(numStr)) {
            escolhasEncontradas.push(item);
        } else if (textNormalizado.includes(itemNormalizado) || itemNormalizado.includes(textNormalizado)) {
            escolhasEncontradas.push(item);
        } else {
            const matchParcial = tokens.some(token => token.length > 3 && itemNormalizado.includes(token));
            if (matchParcial) escolhasEncontradas.push(item);
        }
    });

    escolhasEncontradas = [...new Set(escolhasEncontradas)];

    if (escolhasEncontradas.length > 1 || textNormalizado.includes("todos") || textNormalizado.includes("ambos")) {
        return { erro: "multiplo" };
    }

    return escolhasEncontradas.length === 1 ? { valor: escolhasEncontradas[0] } : { erro: "nao_encontrado" };
}

function resolverEscolhaMultipla(input, lista) {
    const text = input.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (text.includes("todos") || text.includes("tudo") || text.includes("os tres") || text.includes("os 3")) return lista;
    
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
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function getGeocoding(cep, numero) {
    try {
        const apiKey = getApiKey();
        const cepLimpo = cep.replace(/\D/g, '');
        logSystem(`--- INICIANDO NOVO FLUXO DE GEOLOCALIZAÇÃO ---`);
        
        if (!apiKey || apiKey === 'sua_chave_aqui') {
            logSystem(`ERRO: Chave API ORS não encontrada!`, 'error');
            return { erro: 'config_key' };
        }

        logSystem(`1. Consultando ViaCEP para o CEP ${cepLimpo}...`);
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
        const tentativas = [
            `${viaCepData.logradouro}, ${numero}, ${viaCepData.localidade}, RJ, Brasil`,
            `${viaCepData.logradouro}, ${viaCepData.localidade}, RJ, Brasil`
        ];

        for (let i = 0; i < tentativas.length; i++) {
            const query = tentativas[i];
            logSystem(`3.${i+1}. Tentando Geocoding: "${query}"`);

            const orsResponse = await axios.get(`https://api.openrouteservice.org/geocode/search`, {
                params: {
                    api_key: apiKey, text: query, size: 10, 'boundary.country': 'BRA',
                    'focus.point.lat': coordsRestaurante.lat, 'focus.point.lon': coordsRestaurante.lng
                }, timeout: 10000
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
                    logSystem(`4. Endereço Validado: ${melhor.properties.label}`);
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

        if (response.data.routes && response.data.routes.length > 0) {
            return Math.ceil(response.data.routes[0].summary.duration / 60);
        }
        return null;
    } catch (error) { return null; }
}

async function getTaxaEntrega(bairro) {
    try {
        const baseUrl = getTaxasUrl();
        const normalizar = (str) => str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, '-');
        const bairroNormalizado = normalizar(bairro);
        const tentativas = [bairroNormalizado];
        const bairroSimplificado = bairroNormalizado.replace(/-(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i, '').replace(/-(\d+)$/, '');
        if (bairroSimplificado !== bairroNormalizado) tentativas.push(bairroSimplificado);

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

// ----------------------------------------------------
// RECIBO FINAL E FORMATAÇÃO VISUAL
// ----------------------------------------------------
function gerarTextoRecibo(session) {
    let texto = "";
    
    session.marmitasA_Montar.forEach(m => {
        const precoMarmita = m.tipo === 'P' ? '16,90' : '18,90';
        texto += `🍱 *${m.index}ª Marmita ${m.tipo}* (R$ ${precoMarmita})\n`;
        texto += `• Arroz ${m.arroz.toLowerCase()} e Feijão ${m.feijao.charAt(0).toUpperCase() + m.feijao.slice(1).toLowerCase()}\n`;
        
        let textoAcomp = m.acompanhamentos.join(', ');
        if (m.acompanhamentos.length === 2) {
            textoAcomp = m.acompanhamentos.join(' e ');
        } else if (m.acompanhamentos.length > 2) {
            let arr = [...m.acompanhamentos];
            let last = arr.pop();
            textoAcomp = arr.join(', ') + ' e ' + last;
        }
        
        texto += `• Acompanhamento: ${textoAcomp}\n`;
        texto += `• Proteína: ${m.proteina}\n`;
        
        if (m.bebida) {
            texto += `\n• Bebida: ${m.bebida.nome} (R$ ${m.bebida.preco.toFixed(2).replace('.', ',')})\n`;
        }
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
            if (!isNaN(valorTroco)) {
                trocoFormatado = `R$ ${valorTroco.toFixed(2).replace('.', ',')}`;
            }
        } else if (!session.troco.toLowerCase().includes('r$')) {
             trocoFormatado = `R$ ${session.troco}`;
        }
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
    
    if (session.order.bebida) {
        resumoM += `🥤 Bebida: ${session.order.bebida.nome} (+ R$ ${session.order.bebida.preco.toFixed(2).replace('.', ',')})\n`;
    }
    
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
    if (session.endereco.complemento) {
        resumoFinal += `Complemento: ${session.endereco.complemento}\n`;
    }
    const cidadeUF = (session.endereco.cidade && session.endereco.uf) ? ` - ${session.endereco.cidade} - ${session.endereco.uf}` : ' - Resende - RJ';
    resumoFinal += `Bairro: ${session.endereco.bairro}${cidadeUF}\n\n`;

    resumoFinal += `*Posso fechar o pedido pra mandar pra cozinha?*\n1 - Sim\n2 - Não`;
    
    await replyFunc(resumoFinal);
}


// LÓGICA DO FLUXO
async function processMessage(userId, text, rawBody, replyFunc, contactInfo = {}) {
    if (!botAtivo) return;

    if (userSessions[userId] && userSessions[userId].botPausedUntil) {
        if (Date.now() < userSessions[userId].botPausedUntil) {
            return; 
        } else {
            delete userSessions[userId]; 
        }
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

        userSessions[userId] = {
            step: nomeCliente ? 'VER_CARDAPIO' : 'PERGUNTAR_NOME', 
            nome: nomeCliente || '',
            lastInteraction: Date.now(),
            marmitasP: 0, marmitasM: 0,
            marmitasA_Montar: [], currentMarmitaIndex: 0,
            order: {}, proteinasCache: [], bebidasCache: [],
            endereco: {}, taxaEntrega: 0,
            consultaTaxaSomente: false
        };

        if (!nomeCliente) {
            return await replyFunc('Êba! Aqui é o Mineirinho! 🤠 Notei que é sua primeira vez por aqui, sô. Como é que ocê se chama?');
        } else {
            return await replyFunc(`Ôba, ${nomeCliente}! Bão demais da conta ver ocê de novo! 🤠 Bateu aquela broca? Posso te mostrar o cardápio de hoje pra gente montar sua marmita?\n\n*(Responda SIM ou NÃO)*`);
        }
    } 
    
    const session = userSessions[userId];
    session.lastInteraction = Date.now();

    switch (session.step) {
        case 'PERGUNTAR_NOME':
            const nomeInformado = text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
            session.nome = nomeInformado;
            salvarContato(userId, nomeInformado);
            session.step = 'VER_CARDAPIO';
            await replyFunc(`Prazer demais em te conhecer, ${nomeInformado}! 👋 Agora me diz, posso te mostrar o cardápio de hoje pra gente montar aquela marmita caprichada?\n\n*(Responda SIM ou NÃO)*`);
            break;

        case 'VER_CARDAPIO':
            if (isPositiveIntent(text)) {
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
                
                if (!cardapioTexto || cardapioTexto.trim() === "") {
                    cardapioTexto = "Poxa vida, não temos opções cadastradas pra hoje ainda!";
                }

                const menu = `Bão demais da conta! Hoje nosso cardápio tá que tá um trem bão:\n\n` +
                             `🍚 *Arroz:* Branco ou Colorido\n` +
                             `🫘 *Feijão:* Carioca ou Preto\n\n` +
                             `${cardapioTexto}\n\n` +
                             `💰 *NOSSOS PREÇOS (Marmitas):*\n` +
                             `🍱 Marmita P - R$ 16,90\n` +
                             `🍱 Marmita M - R$ 18,90\n\n` +
                             `${bebidasTexto}` +
                             `Gostaria de montar seu pedido agora?\n\n` +
                             `*(Responda SIM ou NÃO)*`;
                await replyFunc(menu);
                session.step = 'ESCOLHA_POS_CARDAPIO';
            } else if (isNegativeIntent(text)) {
                await replyFunc('Ah, que peninha sô. Mas ó, estarei aqui te esperando numa próxima. Um abraço bem apertado! 🙏');
                delete userSessions[userId];
            } else {
                await replyFunc('Ixi, me enrolei aqui sô! Num entendi. Responde com *SIM* ou *NÃO* fazendo favor.');
            }
            break;

        case 'ESCOLHA_POS_CARDAPIO':
            if (isPositiveIntent(text)) {
                await replyFunc('Ô trem bão 😄 Me passa seu *CEP* rapidim só pra eu espiar se a gente entrega nas suas bandas.');
                session.step = 'PEDIR_CEP';
            } else if (isNegativeIntent(text)) {
                await replyFunc('Sem caô! Quando a barriga roncar é só chamar. 👋');
                delete userSessions[userId];
            } else {
                await replyFunc('Ixi, num entendi sô! Quer montar seu pedido agora? (Responda *SIM* ou *NÃO*)');
            }
            break;

        case 'CONFIRMAR_PEDIDO': 
            if (isPositiveIntent(text)) {
                await replyFunc('Maravilha sô! Primeiro, me diz seu *CEP* rapidim pra eu espiar se a gente entrega aí?');
                session.step = 'PEDIR_CEP';
            } else if (isNegativeIntent(text)) {
                await replyFunc('Sem caô! Quando a barriga roncar é só chamar. 👋');
                delete userSessions[userId];
            } else {
                await replyFunc('Ixi, num entendi. Responde com *SIM* ou *NÃO*, fazendo favor.');
            }
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
                if (geo.erro === 'config_key') {
                    await replyFunc('Uai, tive um probleminha técnico aqui com meu sistema de mapas (Chave API não configurada). Peço desculpas, sô! Pode me chamar de novo mais tarde?');
                } else if (geo.erro === 'viacep_fail') {
                    await replyFunc('Vixe Maria, o sistema de busca de CEP deu uma engasgada aqui. 😥 Ocê poderia tentar de novo num instantim, fazendo o favor?');
                } else {
                    await replyFunc('Nossa senhora, meu sistema de mapas deu um tropicão aqui. 😥 Tenta de novo num instantim!');
                }
                delete userSessions[userId];
                return;
            }

            if (!geo) {
                await replyFunc('Uai, não consegui achar esse endereço. 😥 Vamos tentar de novo? Qual que é o seu *CEP* mesmo?');
                session.step = 'PEDIR_CEP';
                return;
            }

            session.endereco = { ...session.endereco, ...geo };
            const confirmacaoMsg = `📍 *Achei esse endereço aqui, ó:*\n\n` +
                                 `Rua: ${geo.rua}\n` +
                                 `Bairro: ${geo.bairro}\n` +
                                 `Cidade: ${geo.cidade} - ${geo.uf}\n` +
                                 `Número: ${session.endereco.numero}\n` +
                                 `Complemento: ${session.endereco.complemento || 'Nenhum'}\n\n` +
                                 `*Tá certim?*\n1 - Sim\n2 - Não`;
            await replyFunc(confirmacaoMsg);
            session.step = 'CONFIRMAR_ENDERECO';
            break;

        case 'CONFIRMAR_ENDERECO':
            if (isPositiveIntent(text)) {
                await replyFunc('Fazendo as conta da entrega aqui... 🛵');
                const minutos = await getRouteDuration(session.endereco.lat, session.endereco.lng);
                
                let motivoIndisponivel = "";

                if (minutos !== null && minutos <= 5) {
                    session.taxaEntrega = 0;
                    await replyFunc('Eita coisa boa! Ocê fica tão pertin de nós que a gente nem vai cobrar a entrega! É por conta da casa 🤠');
                } else {
                    const taxa = await getTaxaEntrega(session.endereco.bairro);
                    if (taxa === null) {
                        motivoIndisponivel = `infelizmente a gente ainda não atende as banda do bairro *${session.endereco.bairro}* 😥`;
                    } else if (minutos !== null && minutos > 45) {
                        motivoIndisponivel = `ocê mora um cadim longe demais pra gente conseguir levar a marmita ainda trincando de quente (vai dar uns ${minutos} min de viagem) 😥`;
                    } else {
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
            } else if (isNegativeIntent(text)) {
                await replyFunc('Tranquilo, vamo começar esse endereço de novo. Qual que é o *CEP* procê?');
                session.step = 'PEDIR_CEP';
            } else {
                await replyFunc('Ixi, num entendi! O endereço aí em cima tá certo? (Responda *SIM* ou *NÃO*)');
            }
            break;

        case 'CONTINUAR_POS_ENDERECO':
            if (isPositiveIntent(text)) {
                await replyFunc('Ô trem bão! Quantas *Marmitas P* (R$ 16,90) e *Marmitas M* (R$ 18,90) ocê vai querer?\n\nPode escrever do seu jeitin mesmo, ex: *"1P e 2M"* ou *"duas P"*');
                session.step = 'DEFINIR_QUANTIDADES';
            } else if (isNegativeIntent(text)) {
                await replyFunc('Tudo bem sô! Agradeço demais a procura. Quando a fome bater é só chamar! 👋');
                delete userSessions[userId];
            } else {
                await replyFunc('Responde com *SIM* ou *NÃO*, fazendo favor. Quer continuar com o pedido?');
            }
            break;

        case 'DEFINIR_QUANTIDADES':
            const qtds = extrairQuantidades(text);
            session.marmitasP = qtds.p; session.marmitasM = qtds.m;
            if (session.marmitasP === 0 && session.marmitasM === 0) {
                await replyFunc('Uai, não consegui entender as quantidade. 😅 Tenta escrever algo tipo *"1 P"* ou *"2 M"*');
                return;
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

            await replyFunc(`Fechado sô! Vão ser ${resumoTexto}. ✅\n\nBora montar a *${m.index}ª Marmita ${m.tipo}*.\n\nQual tipo de *Arroz* ocê prefere?\n1 - Branco\n2 - Colorido`);
            session.step = 'MONTAR_ARROZ';
            break;

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
            let proteinas = [];
            let listaTexto = "Agora o principal, escolhe a *Mistura (Proteína)*:\n";
            let count = 1;
            
            if (dadosCardapio && dadosCardapio.length > 0) {
                const grupoProteinas = dadosCardapio.find(g => g.grupo === "Proteínas");
                if (grupoProteinas && Array.isArray(grupoProteinas.categorias)) {
                    grupoProteinas.categorias.forEach(c => {
                        listaTexto += `\n*${c.categoria || 'Opções'}*\n`;
                        const itensArray = Array.isArray(c.itens) ? c.itens : [];
                        itensArray.forEach(item => {
                            listaTexto += `${count} - ${item}\n`;
                            proteinas.push(item);
                            count++;
                        });
                    });
                }
            }

            if (proteinas.length === 0) {
                return await replyFunc("Vixe Maria, parece que o fogão escondeu as mistura hoje! Num achei as proteínas cadastradas. Desculpa qualquer coisa e muito obrigado! 🙏");
            }

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
            if (text.includes('não') || text.includes('nao') || text.includes('nada')) {
                session.order.acompanhamentos = ['Nenhum'];
            } else {
                const escolhidos = resolverEscolhaMultipla(text, OPCOES_FIXAS.acompanhamentos);
                session.order.acompanhamentos = escolhidos.length > 0 ? escolhidos : ['Nenhum'];
            }
            
            const dadosMenu = await getCardapioRaw();
            let bebidasDoDia = [];
            if (dadosMenu && dadosMenu.length > 0) {
                const grupoBebidas = dadosMenu.find(g => g.grupo === "Bebidas");
                if (grupoBebidas && Array.isArray(grupoBebidas.categorias)) {
                    grupoBebidas.categorias.forEach(c => {
                        const itensArray = Array.isArray(c.itens) ? c.itens : [];
                        bebidasDoDia.push(...itensArray);
                    });
                }
            }

            if (bebidasDoDia.length === 0) {
                await replyFunc('Tudo na panela! 🥗\n\nVixe, hoje faltou bebida no cardápio! Vou pular direto pra revisão da marmita, tá bão?');
                session.order.bebida = null;
                return await enviarConfirmacaoMarmita(session, replyFunc);
            }

            session.bebidasCache = bebidasDoDia;
            let msgBebida = 'Tudo na panela! 🥗\n\nPra molhar a palavra, vai querer bebida? Temos:\n\n';
            
            bebidasDoDia.forEach((b, i) => {
                msgBebida += `${i + 1} - ${b.nome} (R$ ${parseFloat(b.preco).toFixed(2).replace('.', ',')})\n`;
            });
            
            msgBebida += `\n0 - Não quero bebida`;
            await replyFunc(msgBebida);
            session.step = 'ESCOLHER_BEBIDA_FINAL';
            break;
        }

        case 'ESCOLHER_BEBIDA_FINAL': {
            const cleanT = text.toLowerCase().trim();
            // Correção de Bug: Avalia estritamente '0', 'não', 'nao', ou cancelar
            if (cleanT === '0' || cleanT === 'nao' || cleanT === 'não' || cleanT === 'nada' || isCancelIntent(cleanT)) {
                session.order.bebida = null;
            } else {
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
                session.currentMarmitaIndex++; 
                session.order = {}; 
                
                if (session.currentMarmitaIndex < session.marmitasA_Montar.length) {
                    const proxima = session.marmitasA_Montar[session.currentMarmitaIndex];
                    await replyFunc(`Marmita no capricho! ✅\n\nAgora, simbora montar a *${proxima.index}ª Marmita ${proxima.tipo}*.\n\nQual tipo de *Arroz* ocê prefere?\n1 - Branco\n2 - Colorido`);
                    session.step = 'MONTAR_ARROZ';
                } else {
                    let subtotalMarmitas = (session.marmitasP * 16.9) + (session.marmitasM * 18.9);
                    let subtotalBebidas = 0;
                    session.marmitasA_Montar.forEach(m => {
                        if (m.bebida) subtotalBebidas += m.bebida.preco;
                    });
                    
                    session.subtotal = subtotalMarmitas + subtotalBebidas;
                    session.totalPedido = session.subtotal + session.taxaEntrega;

                    const totalFormatado = session.totalPedido.toFixed(2).replace('.', ',');
                    await replyFunc(`Tudo anotadim sô! 📝\nO total da sua conta ficou em *R$ ${totalFormatado}* (já com a entrega).\n\nPra gente despachar seu pedido, como que ocê vai pagar?\n\n1 - Cartão\n2 - Dinheiro\n3 - PIX`);
                    session.step = 'ESCOLHER_PAGAMENTO';
                }
            } else if (isNegativeIntent(text)) {
                const mRefazer = session.marmitasA_Montar[session.currentMarmitaIndex];
                await replyFunc(`Sem caô, a gente desmancha e refaz a *${mRefazer.index}ª Marmita ${mRefazer.tipo}*.\n\nQual tipo de *Arroz* ocê prefere?\n1 - Branco\n2 - Colorido`);
                session.order = {}; 
                session.step = 'MONTAR_ARROZ';
            } else {
                await replyFunc('Eita, num entendi. Manda um *SIM* pra confirmar a marmita ou *NÃO* pra gente refazer.');
            }
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
            } else {
                await replyFunc('Escolhe uma das opções sô:\n1 - Cartão\n2 - Dinheiro\n3 - PIX');
            }
            break;

        case 'PERGUNTAR_TROCO':
            session.troco = (text.toLowerCase() === 'não' || text.toLowerCase() === 'nao') ? 'Não precisa' : text;
            await enviarResumoConfirmacao(session, replyFunc);
            session.step = 'CONFIRMAR_ENVIO_COZINHA';
            break;
            
        case 'CONFIRMAR_ENVIO_COZINHA':
            if (isPositiveIntent(text)) {
                let msgFinal = `✅ *Tudo nos conformes, sô! O Mineirinho já passou o pedido pro fogão. A Estância Mineira te agradece demais da conta! Um abração!* 🤠\n\n`;
                msgFinal += `Seu Pedido ficou assim:\n\n`;
                
                msgFinal += gerarTextoRecibo(session);
                
                msgFinal += `\n\n-----------------------------------------------\n\n`;
                msgFinal += `📍 *Endereço de Entrega:*\n\n`;
                msgFinal += `${session.endereco.rua}, Nº ${session.endereco.numero}\n\n`;
                if (session.endereco.complemento) {
                    msgFinal += `Complemento: ${session.endereco.complemento}\n\n`;
                }
                const cidadeUF = (session.endereco.cidade && session.endereco.uf) ? ` - ${session.endereco.cidade} - ${session.endereco.uf}` : ' - Resende - RJ';
                msgFinal += `Bairro: ${session.endereco.bairro}${cidadeUF}`;
                
                if (session.metodoPagamento === 'PIX') {
                    msgFinal += `\n\n-----------------------------------------------\n\n`;
                    msgFinal += `📲 *Chave PIX:* 65.448.226/0001-03\n*(Assim que transferir, manda o comprovante aqui pra nós)*`;
                }
                
                await replyFunc(msgFinal);
                delete userSessions[userId];
            } else if (isNegativeIntent(text)) {
                await replyFunc('Tranquilo sô, não vamo fechar o pedido não. Se quiser começar de novo, é só mandar um "Oi". 👋');
                delete userSessions[userId];
            } else {
                await replyFunc('Ixi, num entendi. *Posso fechar o pedido pra mandar pra cozinha?* Responde com *SIM* ou *NÃO*.');
            }
            break;
    }
}

// --- CONFIGURAÇÃO DO ELECTRON ---
let mainWindow;
let conectado = false;
let lastQrBase64 = null; 

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 850, 
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true, 
            contextIsolation: false
        }
    });

    mainWindow.loadURL('http://localhost:3000');

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

// --- SERVIDOR EXPRESS ---
const serverApp = express();
serverApp.use(express.json()); 
serverApp.use(express.static(path.join(__dirname, 'public')));
serverApp.use(express.static(path.join(__dirname, 'web')));

// ROTA PARA O PAINEL UI DESLIGAR O ROBÔ
serverApp.post('/toggle-bot', (req, res) => {
    botAtivo = req.body.ativo;
    logSystem(`Robô foi ${botAtivo ? 'ATIVADO' : 'DESATIVADO'} pelo painel.`, botAtivo ? 'info' : 'warn');
    res.json({ success: true, botAtivo });
});

serverApp.get('/status', (req, res) => {
    res.json({ 
        connected: conectado,
        qr: lastQrBase64,
        botAtivo: botAtivo
    });
});

serverApp.post('/simular', async (req, res) => {
    try {
        const { text } = req.body;
        const userId = 'simulacao-ui';
        const replies = []; 
        
        await processMessage(
            userId, 
            (text || '').toLowerCase().trim(), 
            text || '', 
            async (reply) => {
                replies.push(reply); 
            },
            { pushname: 'Testador' }
        );

        res.json({ reply: replies.length > 0 ? replies.join('\n\n---\n\n') : 'O Mineirinho tá pensando...' });
    } catch (err) {
        logSystem(`Erro crítico na simulação: ${err.message}`, 'error');
        res.status(500).json({ reply: 'Vixe Maria, tive um erro interno aqui na simulação. 😥 Tenta de novo num instantim!' });
    }
});

serverApp.listen(3000, () => {
    console.log('🌐 Servidor Express rodando na porta 3000');
});

// --- CLIENTE WHATSAPP ---
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: authPath 
    }),
    puppeteer: {
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

client.on('ready', () => {
    conectado = true;
    lastQrBase64 = null; 
    console.log('✅ Mineirinho conectado!');
    if (mainWindow) {
        mainWindow.loadURL('http://localhost:3000');
    }
});

client.on('disconnected', reason => {
    conectado = false;
    console.log('⚠️ Bot desconectado:', reason);
});

client.on('message', async msg => {
    try {
        if (msg.timestamp < STARTUP_TIME || msg.fromMe || msg.isGroup || msg.from === 'status@broadcast') return;
        const chat = await msg.getChat();
        const contact = await msg.getContact();

        await processMessage(
            msg.from,
            msg.body.toLowerCase().trim(),
            msg.body,
            async (response) => {
                await sendWithTyping(chat, response);
            },
            { pushname: contact.pushname }
        );
    } catch (err) {
        console.log('Erro:', err.message);
    }
});

// --- INICIALIZAÇÃO DO APP ---
app.whenReady().then(() => {
    logSystem('--- APLICAÇÃO INICIADA ---');
    logSystem(`Caminho de dados: ${userDataPath}`);
    logSystem(`Caminho do .env carregado: ${envLog || 'NÃO ENCONTRADO'}`);
    
    const currentKey = getApiKey();
    if (currentKey) {
        const maskedKey = currentKey.substring(0, 10) + '...';
        logSystem(`Chave detectada no sistema: ${maskedKey}`);
    } else {
        logSystem('AVISO: OPENROUTESERVICE_API_KEY está vazia ou não carregada!', 'error');
    }

    createWindow();
    client.initialize();
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
    if (mainWindow === null) createWindow();
});

process.on('unhandledRejection', err => {
    console.log('Promise rejeitada:', err?.message);
});

process.on('uncaughtException', err => {
    console.log('Erro geral:', err?.message);
});