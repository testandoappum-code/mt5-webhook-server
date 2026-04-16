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
// WEBHOOK DO SALDO (MT5) - CRIA CONTA AUTOMATICAMENTE
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
// WEBHOOK DAS ORDENS (MT5) - COM LIMPEZA DE CARACTERES NULOS
// ============================================
app.post('/webhook/order', async (req, res) => {
  console.log('📥 Ordem recebida (raw):', req.body);
  
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }
  
  // Função para limpar caracteres nulos
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
  
  console.log('📥 Dados limpos:', { account_id, asset, direction, entry_price, lots, ticket, is_closed, result });
  
  try {
    // Buscar ou criar o ativo
    let { data: assetData } = await supabase
      .from('trading_assets')
      .select('id')
      .eq('name', asset)
      .maybeSingle();
    
    if (!assetData) {
      const { data: newAsset, error: createError } = await supabase
        .from('trading_assets')
        .insert({ name: asset, symbol: asset })
        .select()
        .single();
      
      if (createError) {
        console.error('❌ Erro ao criar ativo:', createError);
      } else {
        assetData = newAsset;
        console.log('✅ Ativo criado:', asset);
      }
    }
    
    if (is_closed) {
      // Atualizar ordem existente com resultado
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
      
      if (updateError) {
        console.error('❌ Erro ao atualizar ordem:', updateError);
        throw updateError;
      }
      console.log('✅ Ordem atualizada com resultado:', result);
    } else {
      // Inserir nova ordem
      const { data: operation, error: insertError } = await supabase
        .from('trading_operations')
        .insert({
          account_id: account_id,
          asset_id: assetData?.id || null,
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
      
      if (insertError) {
        console.error('❌ Erro ao inserir ordem:', insertError);
        throw insertError;
      }
      console.log('✅ Ordem inserida:', operation);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro geral:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
