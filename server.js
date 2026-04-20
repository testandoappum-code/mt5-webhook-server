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
// WEBHOOK DO SALDO (MT5)
// ============================================
app.post('/webhook/balance', async (req, res) => {
  console.log('💰 Saldo recebido:', req.body);
  
  const { account_id, account_number, account_name, balance, equity, profit } = req.body;
  const accountId = account_id || account_number;
  
  try {
    const { data: existingAccount } = await supabase
      .from('trading_accounts')
      .select('account_number')
      .eq('account_number', String(accountId))
      .maybeSingle();
    
    if (!existingAccount) {
      const { error: insertError } = await supabase.from('trading_accounts').insert({
        account_number: String(accountId),
        name: account_name || `MT5 Conta ${accountId}`,
        nickname: account_name || `MT5 Conta ${accountId}`,
        balance: parseFloat(balance),
        broker: 'MT5'
      });
      
      if (insertError) {
        console.error('❌ Erro ao criar conta:', insertError);
      } else {
        console.log('✅ Conta criada automaticamente:', accountId);
      }
    } else {
      await supabase
        .from('trading_accounts')
        .update({ balance: parseFloat(balance) })
        .eq('account_number', String(accountId));
      
      console.log('✅ Saldo atualizado para conta:', accountId);
    }
    
    await supabase.from('account_balance').insert({
      account_id: String(accountId),
      balance: parseFloat(balance),
      equity: parseFloat(equity),
      profit: parseFloat(profit)
    });
    
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Erro geral:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// WEBHOOK DAS ORDENS (MT5)
// ============================================
app.post('/webhook/order', async (req, res) => {
  console.log('📥 Ordem recebida:', req.body);
  
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }
  
  const cleanString = (str) => {
    if (!str) return str;
    return String(str).replace(/\0/g, '').trim();
  };
  
  const account_id = cleanString(req.body.account_id);
  const asset = cleanString(req.body.asset);
  const direction = cleanString(req.body.direction);
  const entry_price = req.body.entry_price;
  const lots = req.body.lots;
  const ticket = cleanString(req.body.ticket);
  const is_closed = req.body.is_closed === 'true' || req.body.is_closed === true;
  const result = req.body.result;
  
  try {
    let { data: assetData } = await supabase
      .from('trading_assets')
      .select('id')
      .eq('name', asset)
      .maybeSingle();
    
    if (!assetData) {
      const { data: newAsset } = await supabase
        .from('trading_assets')
        .insert({ name: asset, symbol: asset })
        .select()
        .single();
      assetData = newAsset;
    }
    
    if (is_closed) {
      const { error: updateError } = await supabase
        .from('trading_operations')
        .update({
          result: parseFloat(result),
          status: 'Fechada',
          closed_at: new Date().toISOString().split('T')[0],
          exit_price: parseFloat(entry_price) || 0
        })
        .eq('mt5_ticket', ticket)
        .eq('account_id', account_id);
      
      if (updateError) throw updateError;
      console.log('✅ Ordem atualizada com resultado:', result);
    } else {
      const { data: operation, error: insertError } = await supabase
        .from('trading_operations')
        .insert({
          account_id: account_id,
          asset_id: assetData?.id,
          asset: asset,
          direction: direction,
          entry_price: parseFloat(entry_price),
          lots: parseFloat(lots),
          opened_at: new Date().toISOString().split('T')[0],
          status: 'Aberta',
          source: 'mt5',
          mt5_ticket: ticket
        })
        .select()
        .single();
      
      if (insertError) throw insertError;
      console.log('✅ Ordem inserida:', operation);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// TELEGRAM WEBHOOK (RESPOSTA RÁPIDA)
// ============================================
app.post('/webhook/telegram', (req, res) => {
  // Responder imediatamente para evitar timeout
  res.sendStatus(200);
  
  // Processar em segundo plano
  setTimeout(() => {
    try {
      const data = req.body;
      console.log('📥 Telegram webhook recebido');
      
      if (data.message && data.message.text) {
        const texto = data.message.text;
        console.log('📝 Mensagem do Telegram:', texto);
        
        // Verificar se é ORDEM ABERTA
        if (texto.includes('ORDEM ABERTA')) {
          console.log('✅ ORDEM ABERTA DETECTADA');
          // TODO: extrair dados e salvar no Supabase
        }
        
        // Verificar se é ORDEM FECHADA
        if (texto.includes('ORDEM FECHADA')) {
          console.log('✅ ORDEM FECHADA DETECTADA');
          // TODO: extrair dados e salvar no Supabase
        }
      }
    } catch (e) {
      console.log('❌ Erro ao processar:', e.message);
    }
  }, 0);
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
