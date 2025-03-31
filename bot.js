const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { AttachmentBuilder } = require('discord.js');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const multer = require('multer');

// Настройка хранилища для загружаемых файлов
const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        cb(null, 'public/uploads/');
    },
    filename: function(req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ dest: 'public/uploads/' });

// Инициализация Discord бота
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Инициализация базы данных
const db = new sqlite3.Database('./builds.db', (err) => {
    if (err) console.error(err.message);
    console.log('Подключение к БД.');
});

// Создание таблиц при первом запуске
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS builds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS build_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        build_id INTEGER NOT NULL,
        slot TEXT NOT NULL,
        item_name TEXT NOT NULL,
        item_description TEXT,
        item_image TEXT,
        is_alternative BOOLEAN DEFAULT 0,
        FOREIGN KEY (build_id) REFERENCES builds (id)
    )`);
});

// Инициализация веб-сервера
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// Маршруты веб-интерфейса
app.get('/', async (req, res) => {
    db.all("SELECT * FROM builds", [], (err, builds) => {
        if (err) return console.error(err.message);
        res.render('index', { builds });
    });
});

app.get('/build/:id', (req, res) => {
    const buildId = req.params.id;
    
    db.get("SELECT * FROM builds WHERE id = ?", [buildId], (err, build) => {
        if (err) return console.error(err.message);
        
        db.all("SELECT * FROM build_items WHERE build_id = ?", [buildId], (err, items) => {
            if (err) return console.error(err.message);
            
            // Группировка предметов по слотам
            const groupedItems = {};
            items.forEach(item => {
                if (!groupedItems[item.slot]) {
                    groupedItems[item.slot] = [];
                }
                groupedItems[item.slot].push(item);
            });
            
            res.render('build', { build, items: groupedItems });
        });
    });
});

app.get('/add-build', (req, res) => {
    res.render('add-build');
});

app.post('/add-build', (req, res) => {
    const { name, description, type } = req.body;
    
    db.run("INSERT INTO builds (name, description, type) VALUES (?, ?, ?)", 
        [name, description, type], function(err) {
            if (err) return console.error(err.message);
            res.redirect(`/edit-build/${this.lastID}`);
        });
});

app.get('/edit-build/:id', (req, res) => {
    const buildId = req.params.id;
    
    db.get("SELECT * FROM builds WHERE id = ?", [buildId], (err, build) => {
        if (err) return console.error(err.message);
        
        db.all("SELECT * FROM build_items WHERE build_id = ?", [buildId], (err, items) => {
            if (err) return console.error(err.message);
            
            const groupedItems = {};
            items.forEach(item => {
                if (!groupedItems[item.slot]) {
                    groupedItems[item.slot] = [];
                }
                groupedItems[item.slot].push(item);
            });
            
            res.render('edit-build', { build, items: groupedItems });
        });
    });
});

app.post('/update-build/:id', upload.single('item_image'), async (req, res) => {
    try {
        const buildId = req.params.id;
        const { name, description, type, ...formData } = req.body;

        // 1. Обработка данных предметов
        let items = {};
        if (formData.items) {
            try {
                // Парсим items и преобразуем в правильный формат
                const parsedItems = typeof formData.items === 'string' 
                    ? JSON.parse(formData.items) 
                    : formData.items;
                
                // Преобразуем в гарантированный массив для каждого слота
                Object.keys(parsedItems).forEach(slot => {
                    if (parsedItems[slot]) {
                        // Преобразуем в массив, если это не массив
                        items[slot] = Array.isArray(parsedItems[slot]) 
                            ? parsedItems[slot] 
                            : [parsedItems[slot]];
                    }
                });
            } catch (e) {
                console.error('Ошибка парсинга предметов:', e);
                return res.status(400).send('Неверный формат данных элементов');
            }
        }

        // 2. Обработка загруженного изображения
        const uploadedImagePath = req.file ? '/uploads/' + req.file.filename : null;

        // 3. Начинаем транзакцию
        await new Promise((resolve, reject) => {
            db.run("BEGIN TRANSACTION", (err) => err ? reject(err) : resolve());
        });

        // 4. Обновляем информацию о билде
        await new Promise((resolve, reject) => {
            db.run(
                "UPDATE builds SET name = ?, description = ?, type = ? WHERE id = ?",
                [name, description, type, buildId],
                (err) => err ? reject(err) : resolve()
            );
        });

        // 5. Удаляем старые предметы билда
        await new Promise((resolve, reject) => {
            db.run(
                "DELETE FROM build_items WHERE build_id = ?",
                [buildId],
                (err) => err ? reject(err) : resolve()
            );
        });

        // 6. Добавляем новые предметы билда
        const slots = Object.keys(items);
        const insertPromises = [];

        for (const slot of slots) {
            // Гарантируем, что items[slot] - это массив
            const slotItems = Array.isArray(items[slot]) ? items[slot] : [items[slot]];
            
            for (let i = 0; i < slotItems.length; i++) {
                const item = slotItems[i];
                
                // Проверяем, что item существует и содержит необходимые поля
                if (item && item.item_name) {
                    insertPromises.push(new Promise((resolve, reject) => {
                        db.run(
                            "INSERT INTO build_items (build_id, slot, item_name, item_description, item_image, is_alternative) VALUES (?, ?, ?, ?, ?, ?)",
                            [
                                buildId,
                                slot,
                                item.item_name || '',
                                item.item_description || '',
                                item.item_image || uploadedImagePath || '',
                                i > 0 ? 1 : 0 // альтернативный, если не первый
                            ],
                            (err) => err ? reject(err) : resolve()
                        );
                    }));
                }
            }
        }

        await Promise.all(insertPromises);

        // 7. Коммитим транзакцию
        await new Promise((resolve, reject) => {
            db.run("COMMIT", (err) => err ? reject(err) : resolve());
        });

        res.redirect(`/build/${buildId}`);
    } catch (error) {
        // Откатываем транзакцию в случае ошибки
        await new Promise((resolve) => db.run("ROLLBACK", () => resolve()));
        console.error('Ошибка при обновлении сборки:', error);
        res.status(500).send('Ошибка при обновлении сборки: ' + error.message);
    }
});

function getTotalItems(itemsObj) {
    let count = 0;
    for (const slot in itemsObj) {
        count += itemsObj[slot].length;
    }
    return count;
}

// Запуск веб-сервера
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Веб-интерфейс, запущен на http://localhost:${PORT}`);
});

// Обработчики команд Discord бота
client.on('ready', () => {
    console.log(`Вошел в систему как ${client.user.tag}!`);
    
    // Регистрация slash-команд
    const commands = [
        {
            name: 'build',
            description: 'Получите сборку для конкретной активности',
            options: [
                {
                    name: 'type',
                    description: 'Вид активности',
                    type: 3,
                    required: true,
                    choices: [
                        { name: 'Фарминг', value: 'farming' },
                        { name: 'Сольники', value: 'solo_pvp' },
                        { name: 'Группики', value: 'group_pvp' },
                        { name: 'Авалон', value: 'avalon' },
                        { name: 'Ганг', value: 'ganking' },
                        { name: 'Gathering', value: 'gathering' }
                    ]
                }
            ]
        },
        {
            name: 'add_build',
            description: 'Добавить новый билд (только для администраторов)',
            options: [
                {
                    name: 'name',
                    description: 'названик билда',
                    type: 3,
                    required: true
                }
            ]
        }
    ];
    
    // Регистрация команд (для одного сервера)
    client.guilds.cache.first()?.commands.set(commands).then(() => {
        console.log('Зарегистрированные слэш-команды!');
    });
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'build') {
        const type = interaction.options.getString('type');
        const tier = interaction.options.getInteger('tier') || 'any';
        
        db.all("SELECT * FROM builds WHERE type = ?", [type], (err, builds) => {
            if (err) {
                console.error(err.message);
                return interaction.reply({ 
    content: 'An error occurred while fetching builds.', 
    flags: 64 
});
            }
            
            if (builds.length === 0) {
                return interaction.reply({ content: `Не найдено ни одного билда для ${type} активности.`, ephemeral: true });
            }
            
            const selectMenu = new ActionRowBuilder()
                .addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('select_build')
                        .setPlaceholder('Выберите билд')
                        .addOptions(
                            builds.map(build => ({
                                label: build.name,
                                description: build.description?.substring(0, 50) || 'Нет описания',
                                value: build.id.toString()
                            }))
                        )
                );
            
interaction.reply({
    content: `Выберите билд для ${type} (Тир ${tier}):`,
    components: [selectMenu],
    flags: 64 // 64 = EPHEMERAL
});
        });
    }
    
    if (interaction.commandName === 'add_build') {
        if (!interaction.member.permissions.has('ADMINISTRATOR')) {
            return interaction.reply({ 
    content: 'У вас нет разрешения на использование этой команды.', 
    flags: 64 
});
        }
        
        const name = interaction.options.getString('name');
        
        db.run("INSERT INTO builds (name, type) VALUES (?, 'custom')", [name], function(err) {
            if (err) {
                console.error(err.message);
                return interaction.reply({ content: 'Не удалось создать билд.', ephemeral: true });
            }
            
            interaction.reply({
    content: `Сборка «${name}» создана! Отредактируйте ее здесь: http://localhost:3000/edit-build/${this.lastID}`,
    flags: 64
});
        });
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== 'select_build') return;
    
    const buildId = interaction.values[0];
    
    db.get("SELECT * FROM builds WHERE id = ?", [buildId], (err, build) => {
        if (err) {
            console.error(err.message);
            return interaction.reply({ 
                content: 'Произошла ошибка при загрузке билда', 
                flags: 64 
            });
        }
        
        db.all("SELECT * FROM build_items WHERE build_id = ?", [buildId], (err, items) => {
            if (err) {
                console.error(err.message);
                return interaction.reply({ 
                    content: 'Произошла ошибка при загрузке предметов', 
                    flags: 64 
                });
            }
            
            const groupedItems = {};
            items.forEach(item => {
                if (!groupedItems[item.slot]) {
                    groupedItems[item.slot] = [];
                }
                groupedItems[item.slot].push(item);
            });
            
            // Создаем основной Embed
            const embed = new EmbedBuilder()
                .setTitle(build.name)
                .setDescription(build.description || 'Описание отсутствует')
                .setColor(0x0099FF)
                .setTimestamp();
            
            // Создаем строки с изображениями для каждого слота
            const slots = ['Пушка', 'Рука', 'Голова', 'Тело', 'Ноги', 'Плащ', 'Сумка', 'Зелье', 'Еда'];
            
            slots.forEach(slot => {
                if (groupedItems[slot]) {
                    // Формируем список предметов с изображениями
                    const itemsList = groupedItems[slot].map(item => {
                        // Если есть изображение, добавляем его как отдельное поле
                        if (item.item_image) {
                            embed.addFields({
                                name: `${slot.charAt(0).toUpperCase() + slot.slice(1)} - ${item.item_name}`,
                                value: `[​](${item.item_image}) ${item.item_description || ''}`,
                                inline: true
                            });
                            return `• ${item.item_name}`;
                        } else {
                            return `• ${item.item_name}${item.item_description ? ` - ${item.item_description}` : ''}`;
                        }
                    }).join('\n');
                    
                    // Если не было изображений, добавляем обычное поле
                    if (!groupedItems[slot].some(item => item.item_image)) {
                        embed.addFields({ 
                            name: `${slot.charAt(0).toUpperCase() + slot.slice(1)}:`, 
                            value: itemsList || 'Не указано',
                            inline: true
                        });
                    }
                }
            });
            
            interaction.update({ 
                content: `Вот ваш билд для ${build.type}:`,
                embeds: [embed],
                components: [] 
            });
        });
    });
});

// Запуск бота
client.login('MTM1MjczOTcyNTQwMzg4NTU3MA.GcecR2.TNyQNyGMtoeW5IEWPpaiegnHWWu9XJn-BW2B-4');
