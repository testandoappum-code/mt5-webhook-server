const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function calcularResultado(direction, entrada, saida, lotes) {
  const diferenca = direction === 'Long' ? saida - entrada : entrada - saida;
  return diferenca * lotes;
}

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

app.post('/webhook/close', async (req, res) => {
  console.log('📥 Fechamento:', req.body);
  
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }
  
  const { operation_id, exit_price, result_type } = req.body;
  
  try {
    const { data: operation } = await supabase
      .from('trading_operations')
      .select('*')
      .eq('id', operation_id)
      .single();
    
    const resultado = calcularResultado(
      operation.direction,
      operation.entry_price,
      parseFloat(exit_price),
      operation.lots
    );
    
    await supabase
      .from('trading_operations')
      .update({
        exit_price: parseFloat(exit_price),
        result: resultado,
        status: result_type === 'take' ? 'Fechada (Take)' : 'Fechada (Stop)',
        closed_at: new Date().toISOString().split('T')[0]
      })
      .eq('id', operation.id);
    
    const { data: conta } = await supabase
      .from('trading_accounts')
      .select('balance')
      .eq('id', operation.account_id)
      .single();
    
    await supabase
      .from('trading_accounts')
      .update({ balance: (conta.balance || 0) + resultado })
      .eq('id', operation.account_id);
    
    res.json({ success: true, result: resultado });
  } catch (err) {
    console.error('Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
