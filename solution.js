// Заполняйте TODO. c — переданная база; функции выполняют реальные запросы MongoDB.
// Служебный lab.js менять не требуется. Контракты и порядок опытов — в Задание.md.
globalThis.installValidator = async c => {
  return await c.runCommand({
    collMod: "products",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["_id", "name", "category", "price", "variants"],
        properties: {
          _id: {
            bsonType: "string"
          },
          name: {
            bsonType: "string"
          },
          category: {
            bsonType: "string"
          },
          price: {
            bsonType: "decimal",
            minimum: 0
          },
          variants: {
            bsonType: "array",
            items: {
              bsonType: "object",
              required: ["size", "stock"],
              properties: {
                size: {
                  bsonType: "string"
                },
                stock: {
                  bsonType: ["int", "long"],
                  minimum: 0
                }
              }
            }
          }
        }
      }
    },
    validationAction: "error",
    validationLevel: "strict"
  });
};

// Возврат: Promise массива полных Product; порядок _id ASC; [] при отсутствии.
globalThis.searchProducts = async (c, {category, size, qty}) => {
  return await c.products.find({
    "category": category,
    variants: { $elemMatch: { "size": size,  stock: { $gte: qty } }}
  }).sort({ _id: 1 }).toArray();
};

// Технический helper: верните MongoDB cursor с фильтром, сортировкой и limit.
// Один и тот же запрос используется для результата и explain в опыте с индексом.
globalThis.historyCursor = (c, {userId, status}) => {
  return c.orders.find({
    "status": status,
    "userId": userId
  }).sort({ createdAt: -1, _id: 1 }).limit(20);
};
globalThis.history = async (c, input) => historyCursor(c, input).toArray();

// Заполните порядок полей и направления индекса для historyCursor.
globalThis.historyIndex = { userId: 1, status: 1, createdAt: -1, _id: 1 };
// Если добавили hint в historyCursor, измените флаг на true.
globalThis.usesHistoryHint = false;

// Возврат: Promise массива {sku, name, qty, revenue}; revenue — Decimal128.
globalThis.report = async (c, from, to) => {
  const filter = {
    $match: { "createdAt": { $gte: from, $lt: to }, "status": "paid" }
  };
  const group = {
    $group: {
      _id: "$items.sku",
      qty: { $sum: "$items.qty" },
      revenue: { $sum: { $multiply: ["$items.qty", "$items.price"] } }
    }
  };
  const lookup = {
    $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "product" }
  };
  const project = {
    $project: {
      _id: 0,
      sku: "$_id",
      name: { $first: "$product.name" },
      qty: 1,
      revenue: 1
    }
  };
  return await c.orders.aggregate([
    filter,
    { $unwind: "$items" },
    group,
    { $sort: { revenue: -1, _id: 1 } },
    { $limit: 5 },
    lookup,
    project
  ]).toArray();
};

// request: {operationId, userId, items:[{sku,size,qty},{sku,size,qty}]}.
// Входы соответствуют контракту задания. Два SKU различны; порядок items значим.
// Возврат: Promise созданного или ранее сохранённого Order.
// При отказе: throw HWError('ITEM_UNAVAILABLE') или HWError('REQUEST_CONFLICT').
// Сообщение ошибки свободное; сценарий проверяет только error.code.
// transaction(body) предоставлена: body получает c — базу в активной сессии.
// Все операции покупки внутри body выполняйте через этот c.
globalThis.purchase = async (request, trace = () => {}) => {
  const { operationId, userId, items } = request;

  return transaction(async c => {
    // Повтор: заказ с таким operationId уже есть — сравниваем параметры и ничего не пишем.
    const existing = await c.orders.findOne({ _id: operationId });
    if (existing) {
      const same = Number(existing.userId) === Number(userId) &&
        existing.items.length === items.length &&
        existing.items.every((saved, i) =>
          saved.sku === items[i].sku &&
          saved.size === items[i].size &&
          Number(saved.qty) === Number(items[i].qty));
      if (!same) throw HWError("REQUEST_CONFLICT");
      return existing;
    }

    const orderItems = [];
    for (const { sku, size, qty } of items) {
      const r = await c.products.updateOne(
        { _id: sku, variants: { $elemMatch: { size: size, stock: { $gte: qty } } } },
        { $inc: { "variants.$.stock": -qty } }
      );
      trace({ event: "update_inside_transaction", sku, matched: r.matchedCount, modified: r.modifiedCount });
      if (r.modifiedCount !== 1) throw HWError("ITEM_UNAVAILABLE");

      const product = await c.products.findOne({ _id: sku }, { price: 1 });
      orderItems.push({ sku, size, qty: NumberInt(qty), price: product.price });
    }

    await c.orders.insertOne({
      _id: operationId,
      userId: NumberInt(userId),
      createdAt: new Date(),
      status: "created",
      items: orderItems
    });
    return c.orders.findOne({ _id: operationId });
  });
};

// Используйте именно переданный c: он связан с одним MongoDB-клиентом опыта.
// writeProbe: сохранить {_id:id, message} в c.probe с majority и j:true.
// Возврат — результат записи с acknowledged:true. Повтор вызова с тем же id
// должен быть безопасен: оболочка опыта может повторить запись после ошибки связи.
globalThis.writeProbe = async (c, id, message) => {
  return await c.probe.updateOne(
    { _id: id },
    { $set: { message: message } },
    { upsert: true, writeConcern: { w: "majority", j: true, wtimeout: 10000 } }
  );
};
// Возврат — документ c.probe с указанным _id либо null.
globalThis.readProbe = async (c, id) => {
  return await c.probe.findOne({ _id: id });
};

