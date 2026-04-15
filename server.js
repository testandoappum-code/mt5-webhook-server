const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ============================================
// WEBHOOK DO MT5 (ORDENS)
// ============================================
app.post('/webhook/order', async (req, res) => {
  console.log('📥 Webhook recebido:', req.body);
  
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }
  
  const { account_id, asset, direction, entry_price, lots, ticket } = req.body;
  
  try {
    let { data: assetData } = await supabase
      .from('trading_assets')
      .select('id')
      .eq('name', asset)
      .single();
    
    if (!assetData) {
      const { data: newAsset } = await supabase
        .from('trading_assets')
        .insert({ name: asset, symbol: asset })
        .select()
        .single();
      assetData = newAsset;
    }
    
    const { data: operation, error } = await supabase
      .from('trading_operations')
      .insert({
        account_id: account_id,
        asset_id: assetData.id,
        asset: asset,
        quantity: lots,
        direction: direction,
        entry_price: parseFloat(entry_price),
        lots: parseFloat(lots),
        opened_at: new Date().toISOString().split('T')[0],
        status: 'Aberta',
        source: 'mt5',
        mt5_ticket: ticket || null
      })
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, operation });
  } catch (err) {
    console.error('Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// WEBHOOK DO SALDO (MT5) - COM CRIAÇÃO AUTOMÁTICA DE CONTA
// ============================================
app.post('/webhook/balance', async (req, res) => {
  console.log('💰 Saldo recebido:', req.body);
  
  const { account_id, balance, equity, profit } = req.body;
  
  try {
    // Verificar se a conta já existe
    const { data: existingAccount } = await supabase
      .from('trading_accounts')
      .select('id')
      .eq('id', account_id)
      .single();
    
    // Se não existir, criar conta automaticamente
    if (!existingAccount) {
      const { error: insertError } = await supabase.from('trading_accounts').insert({
        id: account_id,
        name: `Conta MT5 ${account_id}`,
        balance: parseFloat(balance)
      });
      
      if (insertError) {
        console.error('Erro ao criar conta:', insertError);
      } else {
        console.log('✅ Conta criada automaticamente:', account_id);
      }
    } else {
      // Atualizar saldo da conta existente
      await supabase
        .from('trading_accounts')
        .update({ balance: parseFloat(balance) })
        .eq('id', account_id);
    }
    
    // Salvar histórico de saldo
    await supabase.from('account_balance').insert({
      account_id: account_id,
      balance: parseFloat(balance),
      equity: parseFloat(equity),
      profit: parseFloat(profit)
    });
    
    res.sendStatus(200);
  } catch (err) {
    console.error('Erro ao salvar saldo:', err);
    res.sendStatus(500);
  }
});

// ============================================
// TELEGRAM WEBHOOK - Menus e comandos
// ============================================
app.post('/webhook/telegram', async (req, res) => {
   const { message } = req.body;
   
   if (!message) {
      return res.sendStatus(200);
   }
   
   const chatId = message.chat.id;
   const text = message.text || "";
   
   let resposta = "";
   let teclado = null;
   
   // Menu principal
   if (text === "/start") {
      resposta = "📋 *Bem-vindo ao Life Dashboard!*\n\nEscolha uma opção abaixo:";
      teclado = {
         reply_markup: {
            keyboard: [
               [{ text: "📊 Trading" }, { text: "🏠 Casa" }],
               [{ text: "🎯 Metas" }, { text: "⚙️ Configurações" }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
         }
      };
   }
   // Menu Trading
   else if (text === "📊 Trading") {
      resposta = "📊 *MENU TRADING*\n\nEscolha uma opção:";
      teclado = {
         reply_markup: {
            keyboard: [
               [{ text: "💰 Saldo atual" }],
               [{ text: "🔙 Voltar" }]
            ],
            resize_keyboard: true
         }
      };
   }
   // Menu Casa
   else if (text === "🏠 Casa") {
      resposta = "🏠 *MENU CASA*\n\nEm breve...";
      teclado = {
         reply_markup: {
            keyboard: [
               [{ text: "🔙 Voltar" }]
            ],
            resize_keyboard: true
         }
      };
   }
   // Menu Metas
   else if (text === "🎯 Metas") {
      resposta = "🎯 *MENU METAS*\n\nEm breve...";
      teclado = {
         reply_markup: {
            keyboard: [
               [{ text: "🔙 Voltar" }]
            ],
            resize_keyboard: true
         }
      };
   }
   // Menu Configurações
   else if (text === "⚙️ Configurações") {
      resposta = "⚙️ *CONFIGURAÇÕES*\n\nEm breve...";
      teclado = {
         reply_markup: {
            keyboard: [
               [{ text: "🔙 Voltar" }]
            ],
            resize_keyboard: true
         }
      };
   }
   // Saldo atual
   else if (text === "💰 Saldo atual") {
      const { data } = await supabase
         .from('account_balance')
         .select('*')
         .order('created_at', { ascending: false })
         .limit(1);
      
      if (data && data.length > 0) {
         resposta = `💰 *SALDO ATUAL*\n\n`;
         resposta += `💵 Saldo: R$ ${parseFloat(data[0].balance).toFixed(2)}\n`;
         resposta += `📊 Equity: R$ ${parseFloat(data[0].equity).toFixed(2)}\n`;
         resposta += `📈 Lucro: R$ ${parseFloat(data[0].profit).toFixed(2)}`;
         if(parseFloat(data[0].profit) >= 0) resposta += " ✅";
         else resposta += " ❌";
      } else {
         resposta = "⏳ Nenhum dado de saldo ainda. Aguarde o MT5 enviar...";
      }
      
      teclado = {
         reply_markup: {
            keyboard: [
               [{ text: "🔙 Voltar" }]
            ],
            resize_keyboard: true
         }
      };
   }
   // Voltar ao menu principal
   else if (text === "🔙 Voltar") {
      resposta = "📋 *Menu Principal*";
      teclado = {
         reply_markup: {
            keyboard: [
               [{ text: "📊 Trading" }, { text: "🏠 Casa" }],
               [{ text: "🎯 Metas" }, { text: "⚙️ Configurações" }]
            ],
            resize_keyboard: true
         }
      };
   }
   // Comando não reconhecido
   else {
      resposta = "❓ Comando não reconhecido.\nDigite /start para ver o menu.";
   }
   
   // Enviar resposta para o Telegram
   const fetch = await import('node-fetch');
   await fetch.default(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
         chat_id: chatId,
         text: resposta,
         parse_mode: "Markdown",
         ...teclado
      })
   });
   
   res.sendStatus(200);
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
