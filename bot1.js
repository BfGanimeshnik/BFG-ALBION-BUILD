const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, REST, Routes } = require('discord.js');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// Конфигурация
const config = {
    token: 'process.env.TOKEN', // ЗАМЕНИТЕ НА РЕАЛЬНЫЙ ТОКЕН
    port: process.env.PORT || 3000,
    uploadDir: 'public/uploads'
};

// Проверка и создание папки для загрузок
if (!fs.existsSync(config.uploadDir)) {
    fs.mkdirSync(config.uploadDir, { recursive: true });
}

// Настройка Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${Date.now()}${ext}`);
    }
});
const upload = multer({ storage });

// Инициализация клиента Discord
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Инициализация базы данных
const db = new sqlite3.Database('./builds.db', (err) => {
    if (err) return console.error('Ошибка подключения к БД:', err);
    console.log('Успешное подключение к БД');
});

// Создание таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS builds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL,
        tier INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS build_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        build_id INTEGER NOT NULL,
        slot TEXT NOT NULL,
        item_name TEXT NOT NULL,
        item_description TEXT,
        item_image TEXT,
        is_alternative BOOLEAN DEFAULT 0,
        FOREIGN KEY(build_id) REFERENCES builds(id)
    )`);
});

// Веб-сервер
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// Маршруты веб-интерфейса
app.get('/', (req, res) => {
    db.all("SELECT * FROM builds ORDER BY created_at DESC", (err, builds) => {
        if (err) {
            console.error('Ошибка получения билдов:', err);
            return res.status(500).send('Ошибка сервера');
        }
        res.render('index', { builds });
    });
});

app.get('/build/:id', (req, res) => {
    const buildId = req.params.id;
    
    db.get("SELECT * FROM builds WHERE id = ?", [buildId], (err, build) => {
        if (err || !build) {
            console.error('Ошибка получения билда:', err);
            return res.status(404).send('Билд не найден');
        }

        db.all("SELECT * FROM build_items WHERE build_id = ? ORDER BY slot, is_alternative", [buildId], (err, items) => {
            if (err) {
                console.error('Ошибка получения предметов:', err);
                return res.status(500).send('Ошибка сервера');
            }

            const groupedItems = {};
            items.forEach(item => {
                groupedItems[item.slot] = groupedItems[item.slot] || [];
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
    const { name, description, type, tier } = req.body;
    
    db.run("INSERT INTO builds (name, description, type, tier) VALUES (?, ?, ?, ?)", 
        [name, description, type, tier], 
        function(err) {
            if (err) {
                console.error('Ошибка создания билда:', err);
                return res.status(500).send('Ошибка создания билда');
            }
            res.redirect(`/edit-build/${this.lastID}`);
        }
    );
});

app.get('/edit-build/:id', (req, res) => {
    const buildId = req.params.id;
    
    db.get("SELECT * FROM builds WHERE id = ?", [buildId], (err, build) => {
        if (err || !build) {
            console.error('Ошибка получения билда:', err);
            return res.status(404).send('Билд не найден');
        }

        db.all("SELECT * FROM build_items WHERE build_id = ? ORDER BY slot, is_alternative", [buildId], (err, items) => {
            if (err) {
                console.error('Ошибка получения предметов:', err);
                return res.status(500).send('Ошибка сервера');
            }

            const groupedItems = {};
            items.forEach(item => {
                groupedItems[item.slot] = groupedItems[item.slot] || [];
                groupedItems[item.slot].push(item);
            });

            res.render('edit-build', { build, items: groupedItems });
        });
    });
});

app.post('/update-build/:id', upload.single('item_image'), async (req, res) => {
    const buildId = req.params.id;
    const { name, description, type, tier, ...formData } = req.body;
    const uploadedImagePath = req.file ? `/uploads/${req.file.filename}` : null;

    try {
        await new Promise((resolve, reject) => {
            db.run("BEGIN TRANSACTION", (err) => err ? reject(err) : resolve());
        });

        // Обновление информации о билде
        await new Promise((resolve, reject) => {
            db.run(
                "UPDATE builds SET name = ?, description = ?, type = ?, tier = ? WHERE id = ?",
                [name, description, type, tier, buildId],
                (err) => err ? reject(err) : resolve()
            );
        });

        // Удаление старых предметов
        await new Promise((resolve, reject) => {
            db.run(
                "DELETE FROM build_items WHERE build_id = ?",
                [buildId],
                (err) => err ? reject(err) : resolve()
            );
        });

        // Добавление новых предметов
        let items = {};
        if (formData.items) {
            try {
                const parsedItems = typeof formData.items === 'string' ? 
                    JSON.parse(formData.items) : formData.items;
                
                Object.keys(parsedItems).forEach(slot => {
                    if (parsedItems[slot]) {
                        items[slot] = Array.isArray(parsedItems[slot]) ? 
                            parsedItems[slot] : [parsedItems[slot]];
                    }
                });
            } catch (e) {
                console.error('Ошибка парсинга предметов:', e);
                throw new Error('Неверный формат данных предметов');
            }
        }

        const insertPromises = [];
        Object.entries(items).forEach(([slot, slotItems]) => {
            slotItems.forEach((item, index) => {
                insertPromises.push(new Promise((resolve, reject) => {
                    db.run(
                        "INSERT INTO build_items (build_id, slot, item_name, item_description, item_image, is_alternative) VALUES (?, ?, ?, ?, ?, ?)",
                        [
                            buildId,
                            slot,
                            item.item_name || '',
                            item.item_description || '',
                            item.item_image || uploadedImagePath || '',
                            index > 0 ? 1 : 0
                        ],
                        (err) => err ? reject(err) : resolve()
                    );
                }));
            });
        });

        await Promise.all(insertPromises);
        await new Promise((resolve, reject) => {
            db.run("COMMIT", (err) => err ? reject(err) : resolve());
        });

        res.redirect(`/build/${buildId}`);
    } catch (error) {
        await new Promise((resolve) => db.run("ROLLBACK", () => resolve()));
        console.error('Ошибка обновления билда:', error);
        res.status(500).send(`Ошибка обновления билда: ${error.message}`);
    }
});

// Discord команды
const discordCommands = [
    {
        name: 'build',
        description: 'Получить сборку для определенной активности',
        options: [
            {
                name: 'type',
                description: 'Тип активности',
                type: 3,
                required: true,
                choices: [
                    { name: 'Фарминг', value: 'farming' },
                    { name: 'Соло ПвП', value: 'solo_pvp' },
                    { name: 'Групповое ПвП', value: 'group_pvp' },
                    { name: 'Авалон', value: 'avalon' },
                    { name: 'Ганкинг', value: 'ganking' },
                    { name: 'Сбор ресурсов', value: 'gathering' }
                ]
            },
            {
                name: 'tier',
                description: 'Уровень снаряжения',
                type: 4,
                required: false,
                choices: [
                    { name: 'T4', value: 4 },
                    { name: 'T5', value: 5 },
                    { name: 'T6', value: 6 },
                    { name: 'T7', value: 7 },
                    { name: 'T8', value: 8 }
                ]
            }
        ]
    },
    {
        name: 'add_build',
        description: 'Добавить новую сборку (только для админов)',
        options: [
            {
                name: 'name',
                description: 'Название сборки',
                type: 3,
                required: true
            }
        ]
    }
];

// Регистрация команд при запуске
client.once('ready', async () => {
    console.log(`Бот ${client.user.tag} готов к работе!`);
    
    try {
        const rest = new REST({ version: '10' }).setToken(config.token);
        await rest.put(
            Routes.applicationCommands(client.user.id), 
            { body: discordCommands }
        );
        console.log('Слэш-команды успешно зарегистрированы!');
    } catch (error) {
        console.error('Ошибка регистрации команд:', error);
    }
});

// Обработчик команд
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    try {
        if (interaction.commandName === 'build') {
            const type = interaction.options.getString('type');
            const tier = interaction.options.getInteger('tier');

            const builds = await new Promise((resolve, reject) => {
                db.all(
                    "SELECT * FROM builds WHERE type = ? AND (? IS NULL OR tier = ?) ORDER BY created_at DESC",
                    [type, tier, tier],
                    (err, rows) => err ? reject(err) : resolve(rows)
                );
            });

            if (!builds || builds.length === 0) {
                return interaction.reply({ 
                    content: `Не найдено сборок для ${type}${tier ? ` T${tier}` : ''}`,
                    ephemeral: true 
                });
            }

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_build')
                .setPlaceholder('Выберите сборку')
                .addOptions(builds.map(build => ({
                    label: build.name.length > 25 ? `${build.name.substring(0, 22)}...` : build.name,
                    description: build.description ? 
                        `${build.description.substring(0, 47)}${build.description.length > 47 ? '...' : ''}` : 
                        'Без описания',
                    value: build.id.toString()
                }));

            await interaction.reply({
                content: `Доступные сборки для ${type}${tier ? ` T${tier}` : ''}:`,
                components: [new ActionRowBuilder().addComponents(selectMenu)],
                ephemeral: true
            });
        }
        else if (interaction.commandName === 'add_build') {
            if (!interaction.memberPermissions.has('ADMINISTRATOR')) {
                return interaction.reply({ 
                    content: '❌ Требуются права администратора', 
                    ephemeral: true 
                });
            }

            const name = interaction.options.getString('name');
            
            const { lastID } = await new Promise((resolve, reject) => {
                db.run(
                    "INSERT INTO builds (name, type) VALUES (?, 'custom')",
                    [name],
                    function(err) { err ? reject(err) : resolve(this) }
                );
            });

            await interaction.reply({
                content: `Сборка "${name}" создана! Отредактируйте её здесь: http://localhost:${config.port}/edit-build/${lastID}`,
                ephemeral: true
            });
        }
    } catch (error) {
        console.error('Ошибка обработки команды:', error);
        await interaction.reply({ 
            content: '❌ Произошла ошибка при выполнении команды', 
            ephemeral: true 
        });
    }
});

// Обработчик выбора сборки
client.on('interactionCreate', async interaction => {
    if (!interaction.isStringSelectMenu() || interaction.customId !== 'select_build') return;

    try {
        const buildId = interaction.values[0];
        
        const [build, items] = await Promise.all([
            new Promise(resolve => {
                db.get("SELECT * FROM builds WHERE id = ?", [buildId], (err, row) => {
                    if (err) throw err;
                    resolve(row);
                });
            }),
            new Promise(resolve => {
                db.all("SELECT * FROM build_items WHERE build_id = ? ORDER BY slot, is_alternative", [buildId], (err, rows) => {
                    if (err) throw err;
                    resolve(rows);
                });
            })
        ]);

        if (!build) {
            return interaction.update({ 
                content: '❌ Сборка не найдена', 
                components: [] 
            });
        }

        const embed = new EmbedBuilder()
            .setTitle(`${build.name}${build.tier ? ` (T${build.tier})` : ''}`)
            .setDescription(build.description || '')
            .setColor(0x0099FF)
            .setFooter({ text: `Тип: ${build.type}` })
            .setTimestamp();

        const slots = {};
        items.forEach(item => {
            slots[item.slot] = slots[item.slot] || [];
            slots[item.slot].push(item);
        });

        Object.entries(slots).forEach(([slot, slotItems]) => {
            const value = slotItems.map(item => {
                const image = item.item_image ? `[​](${item.item_image}) ` : '';
                const desc = item.item_description ? ` - ${item.item_description}` : '';
                return `${image}• ${item.item_name}${desc}`;
            }).join('\n');

            embed.addFields({
                name: slot.toUpperCase(),
                value: value || 'Не указано',
                inline: true
            });
        });

        await interaction.update({
            content: `Сборка для ${build.type}${build.tier ? ` T${build.tier}` : ''}:`,
            embeds: [embed],
            components: []
        });
    } catch (error) {
        console.error('Ошибка обработки выбора:', error);
        await interaction.update({ 
            content: '❌ Произошла ошибка при загрузке сборки', 
            components: [] 
        });
    }
});

// Запуск приложения
app.listen(config.port, () => {
    console.log(`Веб-интерфейс доступен по адресу http://localhost:${config.port}`);
});

client.login(config.token).catch(err => {
    console.error('Ошибка входа бота:', err);
    process.exit(1);
});

// Обработка ошибок
process.on('unhandledRejection', error => {
    console.error('Необработанное исключение:', error);
});
