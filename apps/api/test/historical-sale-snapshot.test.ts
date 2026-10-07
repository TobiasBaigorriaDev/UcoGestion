import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateHistoricalSaleSnapshot } from '../src/modules/offline-sync/historical-sale-snapshot.js';
const item={id:randomUUID(),name:'Original',sku:'OLD',barcode:null,type:'PRODUCT' as const,baseUnit:'UNIT' as const,trackInventory:true,price:'10.00',priceVersion:1};
const configuration={currency:'ARS',items:[item],categories:[],branches:[],cashRegisters:[],paymentMethods:['CASH'] as const};
const quote={currency:'ARS',lines:[{itemId:item.id,itemName:item.name,sku:item.sku,barcode:null,type:item.type,baseUnit:item.baseUnit,trackInventory:true,quantity:'2',unitPrice:'10.00',priceVersion:1,lineTotal:'20.00'}],subtotal:'20.00',discount:'0.00',total:'20.00',discountEvidence:null};
const payments=[{method:'CASH',appliedAmount:'20.00',receivedAmount:'25.00',changeAmount:'5.00'}];
describe('T207/T208 historical configuration semantics',()=>{
  it('accepts the retained snapshot regardless of current deactivation, price or currency',()=>{
    expect(()=>validateHistoricalSaleSnapshot(configuration,{quote,payments})).not.toThrow();
    const newer={...configuration,currency:'USD',items:[{...item,price:'99.00',name:'New',type:'SERVICE' as const,baseUnit:'FRACTIONAL' as const,trackInventory:false}]};
    expect(()=>validateHistoricalSaleSnapshot(newer,{quote,payments})).toThrow('OFFLINE_SNAPSHOT_INVALID');
  });
  it('rejects references and semantics that differ from the signed historical version',()=>{
    for (const change of [{itemId:randomUUID()},{unitPrice:'9.00'},{baseUnit:'FRACTIONAL'},{type:'SERVICE'},{trackInventory:false},{priceVersion:2},{quantity:'2',lineTotal:'19.00'}]) {
      expect(()=>validateHistoricalSaleSnapshot(configuration,{quote:{...quote,lines:[{...quote.lines[0],...change}]},payments})).toThrow();
    }
    expect(()=>validateHistoricalSaleSnapshot(configuration,{quote:{...quote,currency:'USD'},payments})).toThrow();
    expect(()=>validateHistoricalSaleSnapshot(configuration,{quote,payments:[{...payments[0],appliedAmount:'19.00'}]})).toThrow();
  });
});
