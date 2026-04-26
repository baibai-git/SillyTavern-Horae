/**
 * Horae - 核心管理器
 * 负责元数据的存储、解析、聚合
 */

import { parseStoryDate, calculateRelativeTime, calculateDetailedRelativeTime, generateTimeReference, formatRelativeTime, formatFullDateTime } from '../utils/timeUtils.js';
import { detectEffectiveAiLangIsZh, detectEffectiveAiLang } from './i18n.js';

/**
 * @typedef {Object} HoraeTimestamp
 * @property {string} story_date - 剧情日期，如 "10/1"
 * @property {string} story_time - 剧情时间，如 "15:00" 或 "下午"
 * @property {string} absolute - ISO格式的实际时间戳
 */

/**
 * @typedef {Object} HoraeScene
 * @property {string} location - 场景地点
 * @property {string[]} characters_present - 在场角色列表
 * @property {string} atmosphere - 场景氛围
 */

/**
 * @typedef {Object} HoraeEvent
 * @property {boolean} is_important - 是否重要事件
 * @property {string} level - 事件级别：一般/重要/关键
 * @property {string} summary - 事件摘要
 */

/**
 * @typedef {Object} HoraeItemInfo
 * @property {string|null} icon - emoji图标
 * @property {string|null} holder - 持有者
 * @property {string} location - 位置描述
 */

/**
 * @typedef {Object} HoraeMeta
 * @property {HoraeTimestamp} timestamp
 * @property {HoraeScene} scene
 * @property {Object.<string, string>} costumes - 角色服装 {角色名: 服装描述}
 * @property {Object.<string, HoraeItemInfo>} items - 物品追踪
 * @property {HoraeEvent|null} event
 * @property {Object.<string, string|number>} affection - 好感度
 * @property {Object.<string, {description: string, first_seen: string}>} npcs - 临时NPC
 */

/** 创建空的元数据对象 */
export function createEmptyMeta() {
    return {
        timestamp: {
            story_date: '',
            story_time: '',
            absolute: ''
        },
        scene: {
            location: '',
            characters_present: [],
            atmosphere: ''
        },
        costumes: {},
        items: {},
        deletedItems: [],
        events: [],
        affection: {},
        npcs: {},
        agenda: [],
        mood: {},
        relationships: [],
    };
}

/**
 * 提取物品的基本名称（去掉末尾的数量括号）
 * "新鲜牛大骨(5斤)" → "新鲜牛大骨"
 * "清水(9L)" → "清水"
 * "简易急救包" → "简易急救包"（无数量，不变）
 * "简易急救包(已开封)" → 不变（非数字开头的括号不去掉）
 */
// 个体量词：1个 = 就一个，可省略。纯量词(个)(把)也无意义
const COUNTING_CLASSIFIERS = '个把条块张根口份枚只颗支件套双对碗杯盘盆串束扎';
// 容器/批量单位：1箱 = 一箱(里面有很多)，不可省略
// 度量单位(斤/L/kg等)：有实际计量意义，不可省略

// 物品ID：3位数字左补零，如 001, 002, ...
function padItemId(id) { return String(id).padStart(3, '0'); }

export function getItemBaseName(name) {
    return name
        .replace(/[\(（][\d][\d\.\/]*[a-zA-Z\u4e00-\u9fff]*[\)）]$/, '')  // 数字+任意单位
        .replace(new RegExp(`[\\(（][${COUNTING_CLASSIFIERS}][\\)）]$`), '')  // 纯个体量词（AI错误格式）
        .trim();
}

/** 按基本名查找已有物品 */
function findExistingItemByBaseName(stateItems, newName) {
    const newBase = getItemBaseName(newName);
    if (stateItems[newName]) return newName;
    for (const existingName of Object.keys(stateItems)) {
        if (getItemBaseName(existingName) === newBase) {
            return existingName;
        }
    }
    return null;
}

/** Horae 管理器 */
class HoraeManager {
    constructor() {
        this.context = null;
        this.settings = null;
    }

    /** 初始化管理器 */
    init(context, settings) {
        this.context = context;
        this.settings = settings;
    }

    /** 获取 AI 输出语言代码 (zh-CN / zh-TW / en / ja / ko / ru) */
    _getAiOutputLang() {
        return detectEffectiveAiLang(this.settings);
    }

    /** AI 输出语言是否为中文（简体/繁体） */
    _isAiOutputChinese() {
        return detectEffectiveAiLangIsZh(this.settings);
    }

    /** 根据 AI 输出语言获取事件摘要的字数/字符限制描述 */
    _getEventCharLimit() {
        const lang = this._getAiOutputLang();
        if (lang === 'zh-CN' || lang === 'zh-TW') return '30-50字';
        if (lang === 'ko') return '50-80자';
        if (lang === 'ja') return '40-70文字';
        if (lang === 'ru') return '80-150 символов';
        return '80-130 chars';
    }

    /** 根据语言返回用户/角色默认名 */
    _getDefaultNames() {
        const lang = this._getAiOutputLang();
        const userName = this.context?.name1;
        const charName = this.context?.name2;
        const defaults = {
            'zh-CN': ['主角', '角色'], 'zh-TW': ['主角', '角色'],
            'ja': ['主人公', 'キャラ'], 'ko': ['주인공', '캐릭터'],
            'ru': ['протагонист', 'персонаж'],
        };
        const [du, dc] = defaults[lang] || ['protagonist', 'character'];
        return [userName || du, charName || dc];
    }

    /** 获取当前聊天记录 */
    getChat() {
        return this.context?.chat || [];
    }

    /** 获取消息元数据 */
    getMessageMeta(messageIndex) {
        const chat = this.getChat();
        if (messageIndex < 0 || messageIndex >= chat.length) return null;
        return chat[messageIndex].horae_meta || null;
    }

    /** 设置消息元数据 */
    setMessageMeta(messageIndex, meta) {
        const chat = this.getChat();
        if (messageIndex < 0 || messageIndex >= chat.length) return;
        chat[messageIndex].horae_meta = meta;
    }

    /** 聚合所有消息元数据，获取最新状态 */
    getLatestState(skipLast = 0) {
        const chat = this.getChat();
        const state = createEmptyMeta();
        state._previousLocation = '';
        const end = Math.max(0, chat.length - skipLast);
        
        for (let i = 0; i < end; i++) {
            const meta = chat[i].horae_meta;
            if (!meta) continue;
            if (meta._skipHorae) continue;
            
            if (meta.timestamp?.story_date) {
                state.timestamp.story_date = meta.timestamp.story_date;
            }
            if (meta.timestamp?.story_time) {
                state.timestamp.story_time = meta.timestamp.story_time;
            }
            
            if (meta.scene?.location) {
                state._previousLocation = state.scene.location;
                state.scene.location = meta.scene.location;
            }
            if (meta.scene?.atmosphere) {
                state.scene.atmosphere = meta.scene.atmosphere;
            }
            if (meta.scene?.characters_present?.length > 0) {
                state.scene.characters_present = [...meta.scene.characters_present];
            }
            
            if (meta.costumes) {
                Object.assign(state.costumes, meta.costumes);
            }
            
            // 物品：合并更新
            if (meta.items) {
                for (let [name, newInfo] of Object.entries(meta.items)) {
                    // 去掉无意义的数量标记
                    // (1) 裸数字1 → 去掉
                    name = name.replace(/[\(（]1[\)）]$/, '').trim();
                    // 个体量词+数字1 → 去掉
                    name = name.replace(new RegExp(`[\\(（]1[${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                    // 纯个体量词 → 去掉
                    name = name.replace(new RegExp(`[\\(（][${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                    // 度量/容器单位保留
                    
                    // 数量为0视为消耗，自动删除
                    const zeroMatch = name.match(/[\(（]0[a-zA-Z\u4e00-\u9fff]*[\)）]$/);
                    if (zeroMatch) {
                        const baseName = getItemBaseName(name);
                        for (const itemName of Object.keys(state.items)) {
                            if (getItemBaseName(itemName).toLowerCase() === baseName.toLowerCase()) {
                                delete state.items[itemName];
                                console.log(`[Horae] 物品数量归零自动删除: ${itemName}`);
                            }
                        }
                        continue;
                    }
                    
                    // 检测消耗状态标记，视为删除（简繁中+英文兼容）
                    const consumedPatterns = /[\(（](已消耗|已用完|已销毁|已銷毀|消耗殆尽|消耗殆盡|消耗|用尽|用盡|consumed|used\s*up|destroyed|depleted)[\)）]/i;
                    const holderConsumed = /^(消耗|已消耗|已用完|消耗殆尽|消耗殆盡|用尽|用盡|无|無|consumed|used\s*up|depleted|none)$/i;
                    if (consumedPatterns.test(name) || holderConsumed.test(newInfo.holder || '')) {
                        const cleanName = name.replace(consumedPatterns, '').trim();
                        const baseName = getItemBaseName(cleanName || name);
                        for (const itemName of Object.keys(state.items)) {
                            if (getItemBaseName(itemName).toLowerCase() === baseName.toLowerCase()) {
                                delete state.items[itemName];
                                console.log(`[Horae] 物品已消耗自动删除: ${itemName}`);
                            }
                        }
                        continue;
                    }
                    
                    // 基本名匹配已有物品
                    const existingKey = findExistingItemByBaseName(state.items, name);
                    
                    if (existingKey) {
                        const existingItem = state.items[existingKey];
                        const mergedItem = { ...existingItem };
                        const locked = !!existingItem._locked;
                        if (!locked && newInfo.icon) mergedItem.icon = newInfo.icon;
                        if (!locked) {
                            const _impRank = { '': 0, '!': 1, '!!': 2 };
                            const _newR = _impRank[newInfo.importance] ?? 0;
                            const _oldR = _impRank[existingItem.importance] ?? 0;
                            mergedItem.importance = _newR >= _oldR ? (newInfo.importance || '') : (existingItem.importance || '');
                        }
                        if (newInfo.holder !== undefined) mergedItem.holder = newInfo.holder;
                        if (newInfo.location !== undefined) mergedItem.location = newInfo.location;
                        if (!locked && newInfo.description !== undefined && newInfo.description.trim()) {
                            mergedItem.description = newInfo.description;
                        }
                        if (!mergedItem.description) mergedItem.description = existingItem.description || '';
                        
                        if (existingKey !== name) {
                            delete state.items[existingKey];
                        }
                        state.items[name] = mergedItem;
                    } else {
                        state.items[name] = newInfo;
                    }
                }
            }
            
            // 处理已删除物品
            if (meta.deletedItems && meta.deletedItems.length > 0) {
                for (const deletedItem of meta.deletedItems) {
                    const deleteBase = getItemBaseName(deletedItem).toLowerCase();
                    for (const itemName of Object.keys(state.items)) {
                        const itemBase = getItemBaseName(itemName).toLowerCase();
                        if (itemName.toLowerCase() === deletedItem.toLowerCase() ||
                            itemBase === deleteBase) {
                            delete state.items[itemName];
                        }
                    }
                }
            }
            
            // 好感度：支持绝对值和相对值
            if (meta.affection) {
                for (const [key, value] of Object.entries(meta.affection)) {
                    if (typeof value === 'object' && value !== null) {
                        // 新格式：{type: 'absolute'|'relative', value: number|string}
                        if (value.type === 'absolute') {
                            state.affection[key] = value.value;
                        } else if (value.type === 'relative') {
                            const delta = parseFloat(value.value) || 0;
                            state.affection[key] = (state.affection[key] || 0) + delta;
                        }
                    } else {
                        // 旧格式兼容
                        const numValue = typeof value === 'number' ? value : parseFloat(value) || 0;
                        state.affection[key] = (state.affection[key] || 0) + numValue;
                    }
                }
            }
            
            // NPC：逐字段合并，保留_id
            if (meta.npcs) {
                // 可更新字段 vs 受保护字段
                const updatableFields = ['appearance', 'personality', 'relationship', 'age', 'job', 'note'];
                const protectedFields = ['gender', 'race', 'birthday'];
                for (const [name, newNpc] of Object.entries(meta.npcs)) {
                    const existing = state.npcs[name];
                    if (existing) {
                        for (const field of updatableFields) {
                            if (newNpc[field] !== undefined) existing[field] = newNpc[field];
                        }
                        // age变更时记录剧情日期作为基准
                        if (newNpc.age !== undefined && newNpc.age !== '') {
                            if (!existing._ageRefDate) {
                                existing._ageRefDate = state.timestamp.story_date || '';
                            }
                            const oldAgeNum = parseInt(existing.age);
                            const newAgeNum = parseInt(newNpc.age);
                            if (!isNaN(oldAgeNum) && !isNaN(newAgeNum) && oldAgeNum !== newAgeNum) {
                                existing._ageRefDate = state.timestamp.story_date || '';
                            }
                        }
                        // 受保护字段：仅在未设定时才填入
                        for (const field of protectedFields) {
                            if (newNpc[field] !== undefined && !existing[field]) {
                                existing[field] = newNpc[field];
                            }
                        }
                        if (newNpc.last_seen) existing.last_seen = newNpc.last_seen;
                    } else {
                        state.npcs[name] = {
                            appearance: newNpc.appearance || '',
                            personality: newNpc.personality || '',
                            relationship: newNpc.relationship || '',
                            gender: newNpc.gender || '',
                            age: newNpc.age || '',
                            race: newNpc.race || '',
                            job: newNpc.job || '',
                            birthday: newNpc.birthday || '',
                            note: newNpc.note || '',
                            _ageRefDate: newNpc.age ? (state.timestamp.story_date || '') : '',
                            first_seen: newNpc.first_seen || new Date().toISOString(),
                            last_seen: newNpc.last_seen || new Date().toISOString()
                        };
                    }
                }
            }
            // 情绪状态（覆盖式）
            if (meta.mood) {
                for (const [charName, emotion] of Object.entries(meta.mood)) {
                    state.mood[charName] = emotion;
                }
            }
        }
        
        // 过滤用户已删除的NPC（防回滚）
        const deletedNpcs = chat[0]?.horae_meta?._deletedNpcs;
        if (deletedNpcs?.length) {
            for (const name of deletedNpcs) {
                delete state.npcs[name];
                delete state.affection[name];
                delete state.costumes[name];
                delete state.mood[name];
                if (state.scene.characters_present) {
                    state.scene.characters_present = state.scene.characters_present.filter(c => c !== name);
                }
            }
        }
        
        // 为无ID物品分配ID
        let maxId = 0;
        for (const info of Object.values(state.items)) {
            if (info._id) {
                const num = parseInt(info._id, 10);
                if (num > maxId) maxId = num;
            }
        }
        for (const info of Object.values(state.items)) {
            if (!info._id) {
                maxId++;
                info._id = padItemId(maxId);
            }
        }
        
        // 为无ID的NPC分配ID
        let maxNpcId = 0;
        for (const info of Object.values(state.npcs)) {
            if (info._id) {
                const num = parseInt(info._id, 10);
                if (num > maxNpcId) maxNpcId = num;
            }
        }
        for (const info of Object.values(state.npcs)) {
            if (!info._id) {
                maxNpcId++;
                info._id = padItemId(maxNpcId);
            }
        }
        
        return state;
    }

    /** 解析生日字符串，支持 yyyy-mm-dd / yyyy/mm/dd / mm-dd / mm/dd */
    _parseBirthday(str) {
        if (!str) return null;
        let m = str.match(/(\d{2,4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
        if (m) return { year: parseInt(m[1]), month: parseInt(m[2]), day: parseInt(m[3]) };
        m = str.match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
        if (m) return { year: null, month: parseInt(m[1]), day: parseInt(m[2]) };
        return null;
    }

    /** 根据剧情时间推移计算NPC当前年龄（优先使用生日精确计算） */
    calcCurrentAge(npcInfo, currentStoryDate) {
        const original = npcInfo.age || '';
        if (!original || !currentStoryDate) {
            return { display: original, original, changed: false };
        }

        const ageNum = parseInt(original);
        if (isNaN(ageNum)) {
            return { display: original, original, changed: false };
        }

        const curParsed = parseStoryDate(currentStoryDate);
        if (!curParsed || curParsed.type !== 'standard' || !curParsed.year) {
            return { display: original, original, changed: false };
        }

        const bdParsed = this._parseBirthday(npcInfo.birthday);

        // ── 有完整生日(含年份)：精确计算 ──
        if (bdParsed?.year) {
            let age = curParsed.year - bdParsed.year;
            if (bdParsed.month && curParsed.month) {
                if (curParsed.month < bdParsed.month ||
                    (curParsed.month === bdParsed.month && (curParsed.day || 1) < (bdParsed.day || 1))) {
                    age -= 1;
                }
            }
            age = Math.max(0, age);
            return { display: String(age), original, changed: age !== ageNum };
        }

        // 以下两种情况都需要 _ageRefDate
        const refDate = npcInfo._ageRefDate || '';
        if (!refDate) return { display: original, original, changed: false };

        const refParsed = parseStoryDate(refDate);
        if (!refParsed || refParsed.type !== 'standard' || !refParsed.year) {
            return { display: original, original, changed: false };
        }

        // ── 仅有月日生日：用 refDate+age 推算出生年，再精确计算 ──
        if (bdParsed?.month) {
            let birthYear = refParsed.year - ageNum;
            if (refParsed.month) {
                const refBeforeBd = refParsed.month < bdParsed.month ||
                    (refParsed.month === bdParsed.month && (refParsed.day || 1) < (bdParsed.day || 1));
                if (refBeforeBd) birthYear -= 1;
            }
            let currentAge = curParsed.year - birthYear;
            if (curParsed.month) {
                const curBeforeBd = curParsed.month < bdParsed.month ||
                    (curParsed.month === bdParsed.month && (curParsed.day || 1) < (bdParsed.day || 1));
                if (curBeforeBd) currentAge -= 1;
            }
            if (currentAge <= ageNum) return { display: original, original, changed: false };
            return { display: String(currentAge), original, changed: true };
        }

        // ── 无生日：退回旧逻辑 ──
        let yearDiff = curParsed.year - refParsed.year;
        if (refParsed.month && curParsed.month) {
            if (curParsed.month < refParsed.month ||
                (curParsed.month === refParsed.month && (curParsed.day || 1) < (refParsed.day || 1))) {
                yearDiff -= 1;
            }
        }
        if (yearDiff <= 0) return { display: original, original, changed: false };
        return { display: String(ageNum + yearDiff), original, changed: true };
    }

    /** 通过ID查找物品 */
    findItemById(items, id) {
        const normalizedId = id.replace(/^#/, '').trim();
        for (const [name, info] of Object.entries(items)) {
            if (info._id === normalizedId || info._id === padItemId(parseInt(normalizedId, 10))) {
                return [name, info];
            }
        }
        return null;
    }

    /** 获取事件列表（limit=0表示不限制数量） */
    getEvents(limit = 0, filterLevel = 'all', skipLast = 0) {
        const chat = this.getChat();
        const end = Math.max(0, chat.length - skipLast);
        const events = [];
        
        for (let i = 0; i < end; i++) {
            const meta = chat[i].horae_meta;
            if (meta?._skipHorae) continue;
            
            const metaEvents = meta?.events || (meta?.event ? [meta.event] : []);
            
            for (let j = 0; j < metaEvents.length; j++) {
                const evt = metaEvents[j];
                if (!evt?.summary) continue;
                
                if (filterLevel !== 'all' && evt.level !== filterLevel) {
                    continue;
                }
                
                events.push({
                    messageIndex: i,
                    eventIndex: j,
                    timestamp: meta.timestamp,
                    event: evt
                });
                
                if (limit > 0 && events.length >= limit) break;
            }
            if (limit > 0 && events.length >= limit) break;
        }
        
        return events;
    }

    /** 获取重要事件列表（兼容旧调用） */
    getImportantEvents(limit = 0) {
        return this.getEvents(limit, 'all');
    }

    /** 生成紧凑的上下文注入内容（skipLast: swipe时跳过末尾N条消息） */
    generateCompactPrompt(skipLast = 0) {
        const state = this.getLatestState(skipLast);
        const lines = [];

        const lang = this._getAiOutputLang();
        const L = (zh, en, ja, ko, ru) => {
            if (lang === 'zh-CN' || lang === 'zh-TW') return zh;
            if (lang === 'ja') return ja;
            if (lang === 'ko') return ko;
            if (lang === 'ru') return ru;
            return en;
        };
        
        // 状态快照头
        lines.push(L(
            '[当前状态快照——对比本回合剧情，仅在<horae>中输出发生实质变化的字段]',
            '[Current State Snapshot — compare with this round\'s plot, only output substantively changed fields in <horae>]',
            '[現在の状態スナップショット——今回のストーリーと比較し、実質的に変化したフィールドのみ<horae>に出力]',
            '[현재 상태 스냅샷——이번 라운드의 스토리와 비교하여 실질적으로 변경된 필드만 <horae>에 출력]',
            '[Снимок текущего состояния — сравните с сюжетом этого раунда, выводите в <horae> только существенно изменившиеся поля]',
        ));
        
        const sendTimeline = this.settings?.sendTimeline !== false;
        const sendCharacters = this.settings?.sendCharacters !== false;
        const sendItems = this.settings?.sendItems !== false;
        
        // 时间
        if (state.timestamp.story_date) {
            const fullDateTime = formatFullDateTime(state.timestamp.story_date, state.timestamp.story_time);
            lines.push(`[${L('时间','Time','時間','시간','Время')}|${fullDateTime}]`);
            
            // 时间参考
            if (sendTimeline) {
                const timeRef = generateTimeReference(state.timestamp.story_date);
                if (timeRef && timeRef.type === 'standard') {
                    lines.push(`[${L('时间参考','Time Ref','時間参考','시간 참조','Время (справка)')}|${L('昨天','yesterday','昨日','어제','вчера')}=${timeRef.yesterday}|${L('前天','day before','一昨日','그저께','позавчера')}=${timeRef.dayBefore}|${L('3天前','3 days ago','3日前','3일 전','3 дня назад')}=${timeRef.threeDaysAgo}]`);
                } else if (timeRef && timeRef.type === 'fantasy') {
                    lines.push(`[${L('时间参考','Time Ref','時間参考','시간 참조','Время (справка)')}|${L('奇幻日历模式，参见剧情轨迹中的相对时间标记','Fantasy calendar mode, see relative time markers in story timeline','ファンタジー暦モード、ストーリー軌跡の相対時間マーカーを参照','판타지 달력 모드, 스토리 궤적의 상대 시간 마커 참조','Режим фэнтезийного календаря, см. относительные метки времени в сюжетной линии')}]`);
                }
            }
        }
        
        // 场景
        if (state.scene.location) {
            let sceneStr = `[${L('场景','Scene','シーン','장면','Сцена')}|${state.scene.location}`;
            if (state.scene.atmosphere) {
                sceneStr += `|${state.scene.atmosphere}`;
            }
            sceneStr += ']';
            lines.push(sceneStr);

            if (this.settings?.sendLocationMemory) {
                const locMem = this.getLocationMemory();
                const loc = state.scene.location;
                const entry = this._findLocationMemory(loc, locMem, state._previousLocation);
                if (entry?.desc) {
                    lines.push(`[${L('场景记忆','Scene Memory','シーン記憶','장면 기억','Память сцены')}|${entry.desc}]`);
                }
                const sepMatch = loc.match(/[·・\-\/\|]/);
                if (sepMatch) {
                    const parent = loc.substring(0, sepMatch.index).trim();
                    if (parent && locMem[parent] && locMem[parent].desc && parent !== entry?._matchedName) {
                        lines.push(`[${L('场景记忆','Scene Memory','シーン記憶','장면 기억','Память сцены')}:${parent}|${locMem[parent].desc}]`);
                    }
                }
            }
        }
        
        // 在场角色和服装
        if (sendCharacters) {
            const presentChars = state.scene.characters_present || [];
            
            if (presentChars.length > 0) {
                const charStrs = [];
                for (const char of presentChars) {
                    // 模糊匹配服装
                    const costumeKey = Object.keys(state.costumes || {}).find(
                        k => k === char || k.includes(char) || char.includes(k)
                    );
                    if (costumeKey && state.costumes[costumeKey]) {
                        charStrs.push(`${char}(${state.costumes[costumeKey]})`);
                    } else {
                        charStrs.push(char);
                    }
                }
                lines.push(`[${L('在场','Present','出席','참석','Присутствуют')}|${charStrs.join('|')}]`);
            }
            
            // 情绪状态（仅在场角色，变化驱动）
            if (this.settings?.sendMood) {
                const moodEntries = [];
                for (const char of presentChars) {
                    if (state.mood[char]) {
                        moodEntries.push(`${char}:${state.mood[char]}`);
                    }
                }
                if (moodEntries.length > 0) {
                    lines.push(`[${L('情绪','Mood','感情','감정','Настроение')}|${moodEntries.join('|')}]`);
                }
            }
            
            // 关系网络（仅在场角色相关的关系，从 chat[0] 读取，零AI输出token）
            if (this.settings?.sendRelationships) {
                const rels = this.getRelationshipsForCharacters(presentChars);
                if (rels.length > 0) {
                    lines.push(`\n[${L('关系网络','Relationship Network','関係ネットワーク','관계 네트워크','Сеть отношений')}]`);
                    for (const r of rels) {
                        const noteStr = r.note ? `(${r.note})` : '';
                        lines.push(`${r.from}→${r.to}: ${r.type}${noteStr}`);
                    }
                }
            }
        }
        
        // 物品（已装备的物品不在此处显示，避免重复）
        if (sendItems) {
            const items = Object.entries(state.items);
            // 收集已装备物品名集合
            const equippedNames = new Set();
            if (this.settings?.rpgMode && !!this.settings.sendRpgEquipment) {
                const rpgData = this.getRpgStateAt(skipLast);
                for (const [, slots] of Object.entries(rpgData.equipment || {})) {
                    for (const [, eqItems] of Object.entries(slots)) {
                        for (const eq of eqItems) equippedNames.add(eq.name);
                    }
                }
            }
            const unequipped = items.filter(([name]) => !equippedNames.has(name));
            if (unequipped.length > 0) {
                lines.push(`\n[${L('物品清单','Item List','アイテムリスト','아이템 목록','Список предметов')}]`);
                for (const [name, info] of unequipped) {
                    const id = info._id || '???';
                    const icon = info.icon || '';
                    const imp = (info.importance === '!!' || info.importance === '关键' || info.importance === '關鍵') ? L('关键','critical','重要','핵심','критич.') : (info.importance === '!' || info.importance === '重要') ? L('重要','important','重要','중요','важно') : '';
                    const desc = info.description ? ` | ${info.description}` : '';
                    const holder = info.holder || '';
                    const loc = info.location ? `@${info.location}` : '';
                    const impTag = imp ? `[${imp}]` : '';
                    lines.push(`#${id} ${icon}${name}${impTag}${desc} = ${holder}${loc}`);
                }
            } else {
                lines.push(`\n[${L('物品清单','Item List','アイテムリスト','아이템 목록','Список предметов')}] (${L('空','empty','空','비어있음','пусто')})`);
            }
        }
        
        // 好感度
        if (sendCharacters) {
            const affections = Object.entries(state.affection).filter(([_, v]) => v !== 0);
            if (affections.length > 0) {
                const affStr = affections.map(([k, v]) => `${k}:${v > 0 ? '+' : ''}${v}`).join('|');
                lines.push(`[${L('好感','Affection','好感度','호감도','Расположение')}|${affStr}]`);
            }
            
            // NPC信息
            const npcs = Object.entries(state.npcs);
            if (npcs.length > 0) {
                lines.push(`\n[${L('已知NPC','Known NPCs','既知NPC','알려진 NPC','Известные NPC')}]`);
                for (const [name, info] of npcs) {
                    const id = info._id || '?';
                    const app = info.appearance || '';
                    const per = info.personality || '';
                    const rel = info.relationship || '';
                    // 主体：N编号 名｜外貌=性格@关系
                    let npcStr = `N${id} ${name}`;
                    if (app || per || rel) {
                        npcStr += `｜${app}=${per}@${rel}`;
                    }
                    // 扩展字段
                    const extras = [];
                    if (info._aliases?.length) extras.push(`${L('曾用名','aliases','旧名','이전 이름','псевдонимы')}:${info._aliases.join('/')}`);
                    if (info.gender) extras.push(`${L('性别','gender','性別','성별','пол')}:${info.gender}`);
                    if (info.age) {
                        const ageResult = this.calcCurrentAge(info, state.timestamp.story_date);
                        extras.push(`${L('年龄','age','年齢','나이','возраст')}:${ageResult.display}`);
                    }
                    if (info.race) extras.push(`${L('种族','race','種族','종족','раса')}:${info.race}`);
                    if (info.job) extras.push(`${L('职业','occupation','職業','직업','профессия')}:${info.job}`);
                    if (info.birthday) extras.push(`${L('生日','birthday','誕生日','생일','день рождения')}:${info.birthday}`);
                    if (info.note) extras.push(`${L('补充','notes','備考','비고','примечания')}:${info.note}`);
                    if (extras.length > 0) npcStr += `~${extras.join('~')}`;
                    lines.push(npcStr);
                }
            }
        }
        
        // 待办事项
        const chatForAgenda = this.getChat();
        const allAgendaItems = [];
        const seenTexts = new Set();
        const deletedTexts = new Set(chatForAgenda?.[0]?.horae_meta?._deletedAgendaTexts || []);
        const userAgenda = chatForAgenda?.[0]?.horae_meta?.agenda || [];
        for (const item of userAgenda) {
            if (item._deleted || deletedTexts.has(item.text)) continue;
            if (!seenTexts.has(item.text)) {
                allAgendaItems.push(item);
                seenTexts.add(item.text);
            }
        }
        // AI写入的（swipe时跳过末尾消息）
        const agendaEnd = Math.max(0, (chatForAgenda?.length || 0) - skipLast);
        if (chatForAgenda) {
            for (let i = 1; i < agendaEnd; i++) {
                const msgAgenda = chatForAgenda[i].horae_meta?.agenda;
                if (msgAgenda?.length > 0) {
                    for (const item of msgAgenda) {
                        if (item._deleted || deletedTexts.has(item.text)) continue;
                        if (!seenTexts.has(item.text)) {
                            allAgendaItems.push(item);
                            seenTexts.add(item.text);
                        }
                    }
                }
            }
        }
        const activeAgenda = allAgendaItems.filter(a => !a.done);
        if (activeAgenda.length > 0) {
            lines.push(`\n[${L('待办事项','Agenda','予定事項','할 일 목록','Список дел')}]`);
            for (const item of activeAgenda) {
                const datePrefix = item.date ? `${item.date} ` : '';
                lines.push(`· ${datePrefix}${item.text}`);
            }
        }
        
        // RPG 状态（仅启用时注入，按在场角色过滤）
        if (this.settings?.rpgMode) {
            const rpg = this.getRpgStateAt(skipLast);
            const sendBars = this.settings?.sendRpgBars !== false;
            const sendSkills = this.settings?.sendRpgSkills !== false;

            // 属性条名称映射
            const _barCfg = this.settings?.rpgBarConfig || [];
            const _barNames = {};
            for (const b of _barCfg) _barNames[b.key] = b.name;

            // 按在场角色过滤 RPG 数据（无场景数据时发送全部）
            const presentChars = state.scene.characters_present || [];
            const userName = this.context?.name1 || '';
            const _cUoB = !!this.settings?.rpgBarsUserOnly;
            const _cUoS = !!this.settings?.rpgSkillsUserOnly;
            const _cUoA = !!this.settings?.rpgAttrsUserOnly;
            const _cUoE = !!this.settings?.rpgEquipmentUserOnly;
            const _cUoR = !!this.settings?.rpgReputationUserOnly;
            const _cUoL = !!this.settings?.rpgLevelUserOnly;
            const _cUoC = !!this.settings?.rpgCurrencyUserOnly;
            const allRpgNames = new Set([
                ...Object.keys(rpg.bars), ...Object.keys(rpg.status || {}),
                ...Object.keys(rpg.skills), ...Object.keys(rpg.attributes || {}),
                ...Object.keys(rpg.reputation || {}), ...Object.keys(rpg.equipment || {}),
                ...Object.keys(rpg.levels || {}), ...Object.keys(rpg.xp || {}),
                ...Object.keys(rpg.currency || {}),
            ]);
            const rpgAllowed = new Set();
            if (presentChars.length > 0) {
                for (const p of presentChars) {
                    const n = p.trim();
                    if (!n) continue;
                    if (allRpgNames.has(n)) { rpgAllowed.add(n); continue; }
                    if (n === userName && allRpgNames.has(userName)) { rpgAllowed.add(userName); continue; }
                    for (const rn of allRpgNames) {
                        if (rn.includes(n) || n.includes(rn)) { rpgAllowed.add(rn); break; }
                    }
                }
            }
            const filterRpg = rpgAllowed.size > 0;
            // userOnly时构建行不带角色名前缀
            const _ctxPre = (name, isUo) => {
                if (isUo) return '';
                const npc = state.npcs[name];
                return npc?._id ? `N${npc._id} ${name}: ` : `${name}: `;
            };

            if (sendBars && Object.keys(rpg.bars).length > 0) {
                lines.push(`\n[${L('RPG状态','RPG Status','RPGステータス','RPG 상태','RPG-статус')}]`);
                for (const [name, bars] of Object.entries(rpg.bars)) {
                    if (_cUoB && name !== userName) continue;
                    if (filterRpg && !rpgAllowed.has(name)) continue;
                    const parts = [];
                    for (const [type, val] of Object.entries(bars)) {
                        const label = val[2] || _barNames[type] || type.toUpperCase();
                        parts.push(`${label} ${val[0]}/${val[1]}`);
                    }
                    const sts = rpg.status?.[name];
                    if (sts?.length > 0) parts.push(`${L('状态','status','ステータス','상태','статус')}:${sts.join('/')}`);
                    if (parts.length > 0) lines.push(`${_ctxPre(name, _cUoB)}${parts.join(' | ')}`);
                }
                for (const [name, effects] of Object.entries(rpg.status || {})) {
                    if (rpg.bars[name] || effects.length === 0) continue;
                    if (_cUoB && name !== userName) continue;
                    if (filterRpg && !rpgAllowed.has(name)) continue;
                    lines.push(`${_ctxPre(name, _cUoB)}${L('状态','status','ステータス','상태','статус')}:${effects.join('/')}`);
                }
            }

            if (sendSkills && Object.keys(rpg.skills).length > 0) {
                const hasAny = Object.entries(rpg.skills).some(([n, arr]) =>
                    arr?.length > 0 && (!_cUoS || n === userName) && (!filterRpg || rpgAllowed.has(n)));
                if (hasAny) {
                    lines.push(`\n[${L('技能列表','Skill List','スキルリスト','스킬 목록','Список навыков')}]`);
                    for (const [name, skills] of Object.entries(rpg.skills)) {
                        if (!skills?.length) continue;
                        if (_cUoS && name !== userName) continue;
                        if (filterRpg && !rpgAllowed.has(name)) continue;
                        if (!_cUoS) {
                            const npc = state.npcs[name];
                            const pre = npc?._id ? `N${npc._id} ` : '';
                            lines.push(`${pre}${name}:`);
                        }
                        for (const sk of skills) {
                            const lv = sk.level ? ` ${sk.level}` : '';
                            const desc = sk.desc ? ` | ${sk.desc}` : '';
                            lines.push(`  ${sk.name}${lv}${desc}`);
                        }
                    }
                }
            }

            const sendAttrs = this.settings?.sendRpgAttributes !== false;
            const attrCfg = this.settings?.rpgAttributeConfig || [];
            if (sendAttrs && attrCfg.length > 0 && Object.keys(rpg.attributes || {}).length > 0) {
                lines.push(`\n[${L('多维属性','Attributes','多次元属性','다차원 속성','Атрибуты')}]`);
                for (const [name, vals] of Object.entries(rpg.attributes)) {
                    if (_cUoA && name !== userName) continue;
                    if (filterRpg && !rpgAllowed.has(name)) continue;
                    const parts = attrCfg.map(a => `${a.name}${vals[a.key] ?? '?'}`);
                    lines.push(`${_ctxPre(name, _cUoA)}${parts.join(' | ')}`);
                }
            }

            // 装备（按角色独立格位，包含完整物品描述以节省 token）
            const sendEq = !!this.settings?.sendRpgEquipment;
            const eqPerChar = (rpg.equipmentConfig?.perChar) || {};
            const storedEq = this.getChat()?.[0]?.horae_meta?.rpg?.equipment || {};
            if (sendEq && Object.keys(rpg.equipment || {}).length > 0) {
                let hasEqData = false;
                for (const [name, slots] of Object.entries(rpg.equipment)) {
                    if (_cUoE && name !== userName) continue;
                    if (filterRpg && !rpgAllowed.has(name)) continue;
                    const ownerCfg = eqPerChar[name];
                    const validEqSlots = (ownerCfg && Array.isArray(ownerCfg.slots))
                        ? new Set(ownerCfg.slots.map(s => s.name)) : null;
                    const deletedEqSlots = ownerCfg ? new Set(ownerCfg._deletedSlots || []) : new Set();
                    const parts = [];
                    for (const [slotName, items] of Object.entries(slots)) {
                        if (deletedEqSlots.has(slotName)) continue;
                        if (validEqSlots && validEqSlots.size > 0 && !validEqSlots.has(slotName)) continue;
                        for (const item of items) {
                            const attrStr = Object.entries(item.attrs || {}).map(([k, v]) => `${k}${v >= 0 ? '+' : ''}${v}`).join(',');
                            const stored = storedEq[name]?.[slotName]?.find(e => e.name === item.name);
                            const desc = stored?._itemMeta?.description || '';
                            const descPart = desc ? ` "${desc}"` : '';
                            parts.push(`[${slotName}]${item.name}${attrStr ? `{${attrStr}}` : ''}${descPart}`);
                        }
                    }
                    if (parts.length > 0) {
                        if (!hasEqData) { lines.push(`\n[${L('装备','Equipment','装備','장비','Снаряжение')}]`); hasEqData = true; }
                        lines.push(`${_ctxPre(name, _cUoE)}${parts.join(' | ')}`);
                    }
                }
            }

            // 声望（需开关开启）
            const sendRep = !!this.settings?.sendRpgReputation;
            const repConfig = rpg.reputationConfig || { categories: [] };
            if (sendRep && repConfig.categories.length > 0 && Object.keys(rpg.reputation || {}).length > 0) {
                const validRepNames = new Set(repConfig.categories.map(c => c.name));
                const deletedRepNames = new Set(repConfig._deletedCategories || []);
                let hasRepData = false;
                for (const [name, cats] of Object.entries(rpg.reputation)) {
                    if (_cUoR && name !== userName) continue;
                    if (filterRpg && !rpgAllowed.has(name)) continue;
                    const parts = [];
                    for (const [catName, data] of Object.entries(cats)) {
                        if (!validRepNames.has(catName) || deletedRepNames.has(catName)) continue;
                        parts.push(`${catName}:${data.value}`);
                    }
                    if (parts.length > 0) {
                        if (!hasRepData) { lines.push(`\n[${L('声望','Reputation','名声','명성','Репутация')}]`); hasRepData = true; }
                        lines.push(`${_ctxPre(name, _cUoR)}${parts.join(' | ')}`);
                    }
                }
            }

            // 等级
            const sendLvl = !!this.settings?.sendRpgLevel;
            if (sendLvl && (Object.keys(rpg.levels || {}).length > 0 || Object.keys(rpg.xp || {}).length > 0)) {
                const allLvlNames = new Set([...Object.keys(rpg.levels || {}), ...Object.keys(rpg.xp || {})]);
                let hasLvlData = false;
                for (const name of allLvlNames) {
                    if (_cUoL && name !== userName) continue;
                    if (filterRpg && !rpgAllowed.has(name)) continue;
                    const lv = rpg.levels?.[name];
                    const xp = rpg.xp?.[name];
                    if (lv == null && !xp) continue;
                    if (!hasLvlData) { lines.push(`\n[${L('等级','Level','レベル','레벨','Уровень')}]`); hasLvlData = true; }
                    let lvStr = lv != null ? `Lv.${lv}` : '';
                    if (xp) lvStr += ` (${L('经验','XP','経験','경험','опыт')}: ${xp[0]}/${xp[1]})`;
                    lines.push(`${_ctxPre(name, _cUoL)}${lvStr.trim()}`);
                }
            }

            // 货币
            const sendCur = !!this.settings?.sendRpgCurrency;
            const curConfig = rpg.currencyConfig || { denominations: [] };
            if (sendCur && curConfig.denominations.length > 0 && Object.keys(rpg.currency || {}).length > 0) {
                let hasCurData = false;
                for (const [name, coins] of Object.entries(rpg.currency)) {
                    if (_cUoC && name !== userName) continue;
                    if (filterRpg && !rpgAllowed.has(name)) continue;
                    const parts = [];
                    for (const d of curConfig.denominations) {
                        const val = coins[d.name];
                        if (val != null) parts.push(`${d.name}×${val}`);
                    }
                    if (parts.length > 0) {
                        if (!hasCurData) { lines.push(`\n[${L('货币','Currency','通貨','화폐','Валюта')}]`); hasCurData = true; }
                        lines.push(`${_ctxPre(name, _cUoC)}${parts.join(', ')}`);
                    }
                }
            }

            // 据点（从快照读取，支持楼层倒回）
            if (!!this.settings?.sendRpgStronghold) {
                const shNodes = rpg.strongholds || [];
                if (shNodes.length > 0) {
                    lines.push(`\n[${L('据点','Stronghold','拠点','거점','Опорный пункт')}]`);
                    function _shTreeStr(nodes, parentId, indent) {
                        const children = nodes.filter(n => (n.parent || null) === parentId);
                        let str = '';
                        for (const c of children) {
                            const lvStr = c.level != null ? ` Lv.${c.level}` : '';
                            str += `${'  '.repeat(indent)}${c.name}${lvStr}`;
                            if (c.desc) str += ` — ${c.desc}`;
                            str += '\n';
                            str += _shTreeStr(nodes, c.id, indent + 1);
                        }
                        return str;
                    }
                    lines.push(_shTreeStr(shNodes, null, 0).trimEnd());
                }
            }
        }

        // 剧情轨迹
        if (sendTimeline) {
            const allEvents = this.getEvents(0, 'all', skipLast);
            // 过滤掉被活跃摘要覆盖的原始事件（_compressedBy 且摘要为 active）
            const timelineChat = this.getChat();
            const autoSums = timelineChat?.[0]?.horae_meta?.autoSummaries || [];
            const activeSumIds = new Set(autoSums.filter(s => s.active).map(s => s.id));
            // 被活跃摘要压缩的事件不发送；摘要为 inactive 时其 _summaryId 事件不发送
            const events = allEvents.filter(e => {
                if (e.event?._compressedBy && activeSumIds.has(e.event._compressedBy)) return false;
                if (e.event?._summaryId && !activeSumIds.has(e.event._summaryId)) return false;
                return true;
            });
            if (events.length > 0) {
                lines.push(`\n[${L('剧情轨迹','Story Timeline','ストーリー軌跡','스토리 궤적','Сюжетная линия')}]`);
                
                const currentDate = state.timestamp?.story_date || '';
                
                const getLevelMark = (level) => {
                    if (level === '关键' || level === '關鍵') return '★';
                    if (level === '重要') return '●';
                    return '○';
                };
                
                const getRelativeDesc = (eventDate) => {
                    if (!eventDate || !currentDate) return '';
                    const result = calculateDetailedRelativeTime(eventDate, currentDate);
                    if (result.days === null || result.days === undefined) return '';
                    
                    const { days, fromDate, toDate } = result;
                    
                    if (days === 0) return `(${L('今天','today','今日','오늘','сегодня')})`;
                    if (days === 1) return `(${L('昨天','yesterday','昨日','어제','вчера')})`;
                    if (days === 2) return `(${L('前天','day before yesterday','一昨日','그저께','позавчера')})`;
                    if (days === 3) return `(${L('大前天','3 days ago','3日前','그끄저께','3 дня назад')})`;
                    if (days === -1) return `(${L('明天','tomorrow','明日','내일','завтра')})`;
                    if (days === -2) return `(${L('后天','day after tomorrow','明後日','모레','послезавтра')})`;
                    if (days === -3) return `(${L('大后天','in 3 days','3日後','글피','через 3 дня')})`;
                    
                    if (days >= 4 && days <= 13 && fromDate) {
                        const weekday = fromDate.getDay();
                        const wdLabel = L(
                            ['日','一','二','三','四','五','六'][weekday],
                            ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][weekday],
                            ['日','月','火','水','木','金','土'][weekday],
                            ['일','월','화','수','목','금','토'][weekday],
                            ['вс','пн','вт','ср','чт','пт','сб'][weekday],
                        );
                        return `(${L(`上周${wdLabel}`, `last ${wdLabel}`, `先週${wdLabel}`, `지난주 ${wdLabel}`, `прошлый ${wdLabel}`)})`;
                    }
                    
                    if (days >= 20 && days < 60 && fromDate && toDate) {
                        const fromMonth = fromDate.getMonth();
                        const toMonth = toDate.getMonth();
                        if (fromMonth !== toMonth) {
                            const d = fromDate.getDate();
                            return `(${L(`上个月${d}号`, `last month ${d}th`, `先月${d}日`, `지난달 ${d}일`, `прошлый месяц ${d}-го`)})`;
                        }
                    }
                    
                    if (days >= 300 && fromDate && toDate) {
                        const fromYear = fromDate.getFullYear();
                        const toYear = toDate.getFullYear();
                        if (fromYear < toYear) {
                            const m = fromDate.getMonth() + 1;
                            return `(${L(`去年${m}月`, `last year month ${m}`, `去年${m}月`, `작년 ${m}월`, `прошлый год, ${m}-й мес.`)})`;
                        }
                    }
                    
                    if (days > 0 && days < 30) return `(${L(`${days}天前`, `${days} days ago`, `${days}日前`, `${days}일 전`, `${days} дн. назад`)})`;
                    if (days > 0) { const m = Math.round(days / 30); return `(${L(`${m}个月前`, `${m} months ago`, `${m}ヶ月前`, `${m}개월 전`, `${m} мес. назад`)})`; }
                    if (days === -999 || days === -998 || days === -997) return '';
                    return '';
                };
                
                const sortedEvents = [...events].sort((a, b) => {
                    return (a.messageIndex || 0) - (b.messageIndex || 0);
                });
                
                const criticalAndImportant = sortedEvents.filter(e =>
                    e.event?.level === '关键' || e.event?.level === '關鍵' || e.event?.level === '重要' || e.event?.level === '摘要' || e.event?.isSummary
                );
                // 普通事件改为全量发送；由自动总结机制控制历史体量
                const normalEvents = sortedEvents.filter(e =>
                    (e.event?.level === '一般' || !e.event?.level) && !e.event?.isSummary
                );
                
                const allToShow = [...criticalAndImportant, ...normalEvents]
                    .sort((a, b) => (a.messageIndex || 0) - (b.messageIndex || 0));
                
                // 预构建 summaryId→日期范围 映射，让摘要事件带上时间跨度
                const _sumDateRanges = {};
                for (const s of autoSums) {
                    if (!s.active || !s.originalEvents?.length) continue;
                    const dates = s.originalEvents.map(oe => oe.timestamp?.story_date).filter(Boolean);
                    if (dates.length > 0) {
                        const first = dates[0], last = dates[dates.length - 1];
                        _sumDateRanges[s.id] = first === last ? first : `${first}~${last}`;
                    }
                }

                for (const e of allToShow) {
                    const isSummary = e.event?.isSummary || e.event?.level === '摘要';
                    if (isSummary) {
                        const dateRange = e.event?._summaryId ? _sumDateRanges[e.event._summaryId] : '';
                        const dateTag = dateRange ? `·${dateRange}` : '';
                        const relTag = dateRange ? getRelativeDesc(dateRange.split('~')[0]) : '';
                        lines.push(`📋 [${L('摘要','Summary','要約','요약','Сводка')}${dateTag}]${relTag}: ${e.event.summary}`);
                    } else {
                        const mark = getLevelMark(e.event?.level);
                        const date = e.timestamp?.story_date || '?';
                        const time = e.timestamp?.story_time || '';
                        const timeStr = time ? `${date} ${time}` : date;
                        const relativeDesc = getRelativeDesc(e.timestamp?.story_date);
                        const msgNum = e.messageIndex !== undefined ? `#${e.messageIndex}` : '';
                        lines.push(`${mark} ${msgNum} ${timeStr}${relativeDesc}: ${e.event.summary}`);
                    }
                }
            }
        }
        
        // 自定义表格数据（合并全局、角色和本地）
        const chat = this.getChat();
        const firstMsg = chat?.[0];
        const localTables = firstMsg?.horae_meta?.customTables || [];
        const resolvedCharacter = this._getResolvedCharacterTables();
        const resolvedGlobal = this._getResolvedGlobalTables();
        const allTables = [...resolvedGlobal, ...resolvedCharacter, ...localTables];
        for (const table of allTables) {
            const rows = table.rows || 2;
            const cols = table.cols || 2;
            const data = table.data || {};
            
            // 有内容或有填表说明才输出
            const hasContent = Object.values(data).some(v => v && v.trim());
            const hasPrompt = table.prompt && table.prompt.trim();
            if (!hasContent && !hasPrompt) continue;
            
            const tableName = table.name || L('自定义表格','Custom Table','カスタムテーブル','커스텀 테이블','Пользовательская таблица');
            lines.push(`\n[${tableName}](${rows - 1}${L('行','rows','行','행','строк')}×${cols - 1}${L('列','cols','列','열','столбцов')})`);
            
            if (table.prompt && table.prompt.trim()) {
                lines.push(`(${L('填写要求','Instructions','記入要件','작성 요구사항','Инструкции')}: ${table.prompt.trim()})`);
            }
            
            // 检测最后有内容的行（含行标题列）
            let lastDataRow = 0;
            for (let r = rows - 1; r >= 1; r--) {
                for (let c = 0; c < cols; c++) {
                    if (data[`${r}-${c}`] && data[`${r}-${c}`].trim()) {
                        lastDataRow = r;
                        break;
                    }
                }
                if (lastDataRow > 0) break;
            }
            if (lastDataRow === 0) lastDataRow = 1;
            
            const lockedRows = new Set(table.lockedRows || []);
            const lockedCols = new Set(table.lockedCols || []);
            const lockedCells = new Set(table.lockedCells || []);

            // 输出表头行（带坐标标注）
            const headerRow = [];
            for (let c = 0; c < cols; c++) {
                const label = data[`0-${c}`] || (c === 0 ? L('表头','Header','見出し','헤더','Заголовок') : `${L('列','Col','列','열','Столбец')}${c}`);
                const coord = `[0,${c}]`;
                headerRow.push(lockedCols.has(c) ? `${coord}${label}🔒` : `${coord}${label}`);
            }
            lines.push(headerRow.join(' | '));

            // 输出数据行（带坐标标注）
            for (let r = 1; r <= lastDataRow; r++) {
                const rowData = [];
                for (let c = 0; c < cols; c++) {
                    const coord = `[${r},${c}]`;
                    if (c === 0) {
                        const label = data[`${r}-0`] || `${r}`;
                        rowData.push(lockedRows.has(r) ? `${coord}${label}🔒` : `${coord}${label}`);
                    } else {
                        const val = data[`${r}-${c}`] || '';
                        rowData.push(lockedCells.has(`${r}-${c}`) ? `${coord}${val}🔒` : `${coord}${val}`);
                    }
                }
                lines.push(rowData.join(' | '));
            }
            
            // 标注被省略的尾部空行
            if (lastDataRow < rows - 1) {
                lines.push(`(${L(
                    `共${rows - 1}行，第${lastDataRow + 1}-${rows - 1}行暂无数据`,
                    `${rows - 1} rows total, rows ${lastDataRow + 1}-${rows - 1} have no data`,
                    `全${rows - 1}行、第${lastDataRow + 1}-${rows - 1}行はデータなし`,
                    `총 ${rows - 1}행, ${lastDataRow + 1}-${rows - 1}행 데이터 없음`,
                    `всего ${rows - 1} строк, строки ${lastDataRow + 1}-${rows - 1} пусты`,
                )})`);
            }

            // 提示完全空的数据列
            const emptyCols = [];
            for (let c = 1; c < cols; c++) {
                let colHasData = false;
                for (let r = 1; r < rows; r++) {
                    if (data[`${r}-${c}`] && data[`${r}-${c}`].trim()) { colHasData = true; break; }
                }
                if (!colHasData) emptyCols.push(c);
            }
            if (emptyCols.length > 0) {
                const emptyColNames = emptyCols.map(c => data[`0-${c}`] || `${L('列','Col','列','열','Столбец')}${c}`);
                lines.push(`(${emptyColNames.join(L('、',', ','、',', ',', '))}${L('：暂无数据，如剧情中已有相关信息请填写',': no data yet, please fill in if relevant info exists in the story','：データなし、ストーリーに関連情報があれば記入してください',': 데이터 없음, 스토리에 관련 정보가 있으면 작성해 주세요',': нет данных, заполните, если в сюжете есть соответствующая информация')})`);
            }
        }
        
        return lines.join('\n');
    }

    /** 获取好感度等级描述 */
    getAffectionLevel(value) {
        if (value >= 80) return '挚爱';
        if (value >= 60) return '亲密';
        if (value >= 40) return '好感';
        if (value >= 20) return '友好';
        if (value >= 0) return '中立';
        if (value >= -20) return '冷淡';
        if (value >= -40) return '厌恶';
        if (value >= -60) return '敌视';
        return '仇恨';
    }

    /**
     * 根据用户配置的标签列表（逗号分隔），
     * 整段移除对应标签及其内容（含可选属性），
     * 防止小剧场等自定义区块内的 horae 标签污染正文解析。
     */
    _stripCustomTags(text, tagList) {
        if (!text || !tagList) return text;
        const tags = tagList.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);
        for (const tag of tags) {
            const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            text = text.replace(new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?</${escaped}>`, 'gi'), '');
        }
        return text;
    }

    /** 解析AI回复中的horae标签 */
    parseHoraeTag(message) {
        if (!message) return null;

        // 剥离 <think>/<thinking> 块，防止思维链内的 horae 标签污染解析
        message = message.replace(/<think(?:ing)?[\s>][\s\S]*?<\/think(?:ing)?>/gi, '');
        
        // 提取所有 <horae> 块；多块时优先选最靠后的有效块（正文末尾的才是真正输出）
        let match = null;
        const allHoraeMatches = [...message.matchAll(/<horae>([\s\S]*?)<\/horae>/gi)];
        const horaeFieldPattern = /^(time|timestamp|location|atmosphere|scene_desc|characters|costume|item[!]*|item-|event|affection|npc|agenda|agenda-|rel|mood):/m;
        if (allHoraeMatches.length > 1) {
            match = [...allHoraeMatches].reverse().find(m => horaeFieldPattern.test(m[1]))
                 || allHoraeMatches[allHoraeMatches.length - 1];
        } else if (allHoraeMatches.length === 1) {
            match = allHoraeMatches[0];
        }
        if (!match) {
            match = message.match(/<!--horae([\s\S]*?)-->/i);
        }
        
        const allEventMatches = [...message.matchAll(/<horaeevent>([\s\S]*?)<\/horaeevent>/gi)];
        const eventMatch = allEventMatches.length > 1
            ? ([...allEventMatches].reverse().find(m => /^event:/m.test(m[1])) || allEventMatches[allEventMatches.length - 1])
            : allEventMatches[0] || null;
        const tableMatches = [...message.matchAll(/<horaetable[:：]\s*(.+?)>([\s\S]*?)<\/horaetable(?:[:：][^>]*)?>/gi)];
        const rpgMatches = [...message.matchAll(/<horaerpg>([\s\S]*?)<\/horaerpg>/gi)];
        
        if (!match && !eventMatch && tableMatches.length === 0 && rpgMatches.length === 0) return null;
        
        const content = match ? match[1].trim() : '';
        const eventContent = eventMatch ? eventMatch[1].trim() : '';
        const lines = content.split('\n').concat(eventContent.split('\n'));
        
        const result = {
            timestamp: {},
            costumes: {},
            items: {},
            deletedItems: [],
            events: [],
            affection: {},
            npcs: {},
            scene: {},
            agenda: [],
            deletedAgenda: [],
            mood: {},
            relationships: [],
        };
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            
            // time:10/1 15:00 或 time:小镇历永夜2931年 2月1日(五) 20:30
            if (trimmedLine.startsWith('time:')) {
                const timeStr = trimmedLine.substring(5).trim();
                // 从末尾分离 HH:MM 时钟时间
                const clockMatch = timeStr.match(/\b(\d{1,2}:\d{2})\s*$/);
                if (clockMatch) {
                    result.timestamp.story_time = clockMatch[1];
                    result.timestamp.story_date = timeStr.substring(0, timeStr.lastIndexOf(clockMatch[1])).trim();
                } else {
                    // 无时钟时间，整个字符串作为日期
                    result.timestamp.story_date = timeStr;
                    result.timestamp.story_time = '';
                }
            }
            // location:咖啡馆二楼
            else if (trimmedLine.startsWith('location:')) {
                result.scene.location = trimmedLine.substring(9).trim();
            }
            // atmosphere:轻松
            else if (trimmedLine.startsWith('atmosphere:')) {
                result.scene.atmosphere = trimmedLine.substring(11).trim();
            }
            // scene_desc:地点的固定物理特征描述（支持同一回复多场景配对）
            else if (trimmedLine.startsWith('scene_desc:')) {
                const desc = trimmedLine.substring(11).trim();
                result.scene.scene_desc = desc;
                if (result.scene.location && desc) {
                    if (!result.scene._descPairs) result.scene._descPairs = [];
                    result.scene._descPairs.push({ location: result.scene.location, desc });
                }
            }
            // characters:爱丽丝,鲍勃
            else if (trimmedLine.startsWith('characters:')) {
                const chars = trimmedLine.substring(11).trim();
                result.scene.characters_present = chars.split(/[,，]/).map(c => c.trim()).filter(Boolean);
            }
            // costume:爱丽丝=白色连衣裙
            else if (trimmedLine.startsWith('costume:')) {
                const costumeStr = trimmedLine.substring(8).trim();
                const eqIndex = costumeStr.indexOf('=');
                if (eqIndex > 0) {
                    const char = costumeStr.substring(0, eqIndex).trim();
                    const costume = costumeStr.substring(eqIndex + 1).trim();
                    result.costumes[char] = costume;
                }
            }
            // item-:物品名 表示物品已消耗/删除
            else if (trimmedLine.startsWith('item-:')) {
                const itemName = trimmedLine.substring(6).trim();
                const cleanName = itemName.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, '').trim();
                if (cleanName) {
                    result.deletedItems.push(cleanName);
                }
            }
            // item:🍺劣质麦酒|描述=酒馆@吧台 / item!:📜重要物品|特殊功能描述=角色@位置 / item!!:💎关键物品=@位置
            else if (trimmedLine.startsWith('item!!:') || trimmedLine.startsWith('item!:') || trimmedLine.startsWith('item:')) {
                let importance = '';  // 一般用空字符串
                let itemStr;
                if (trimmedLine.startsWith('item!!:')) {
                    importance = '!!';  // 关键
                    itemStr = trimmedLine.substring(7).trim();
                } else if (trimmedLine.startsWith('item!:')) {
                    importance = '!';   // 重要
                    itemStr = trimmedLine.substring(6).trim();
                } else {
                    itemStr = trimmedLine.substring(5).trim();
                }
                
                const eqIndex = itemStr.indexOf('=');
                if (eqIndex > 0) {
                    let itemNamePart = itemStr.substring(0, eqIndex).trim();
                    const rest = itemStr.substring(eqIndex + 1).trim();
                    
                    let icon = null;
                    let itemName = itemNamePart;
                    let description = undefined;  // undefined = 合并时不覆盖原有描述
                    
                    const emojiMatch = itemNamePart.match(/^([\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]|[\u{231A}-\u{231B}]|[\u{23E9}-\u{23F3}]|[\u{23F8}-\u{23FA}]|[\u{25AA}-\u{25AB}]|[\u{25B6}]|[\u{25C0}]|[\u{25FB}-\u{25FE}]|[\u{2614}-\u{2615}]|[\u{2648}-\u{2653}]|[\u{267F}]|[\u{2693}]|[\u{26A1}]|[\u{26AA}-\u{26AB}]|[\u{26BD}-\u{26BE}]|[\u{26C4}-\u{26C5}]|[\u{26CE}]|[\u{26D4}]|[\u{26EA}]|[\u{26F2}-\u{26F3}]|[\u{26F5}]|[\u{26FA}]|[\u{26FD}]|[\u{2702}]|[\u{2705}]|[\u{2708}-\u{270D}]|[\u{270F}]|[\u{2712}]|[\u{2714}]|[\u{2716}]|[\u{271D}]|[\u{2721}]|[\u{2728}]|[\u{2733}-\u{2734}]|[\u{2744}]|[\u{2747}]|[\u{274C}]|[\u{274E}]|[\u{2753}-\u{2755}]|[\u{2757}]|[\u{2763}-\u{2764}]|[\u{2795}-\u{2797}]|[\u{27A1}]|[\u{27B0}]|[\u{27BF}]|[\u{2934}-\u{2935}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{2B50}]|[\u{2B55}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}])/u);
                    if (emojiMatch) {
                        icon = emojiMatch[1];
                        itemNamePart = itemNamePart.substring(icon.length).trim();
                    }
                    
                    const pipeIndex = itemNamePart.indexOf('|');
                    if (pipeIndex > 0) {
                        itemName = itemNamePart.substring(0, pipeIndex).trim();
                        const descText = itemNamePart.substring(pipeIndex + 1).trim();
                        if (descText) description = descText;
                    } else {
                        itemName = itemNamePart;
                    }
                    
                    // 去掉无意义的数量标记
                    itemName = itemName.replace(/[\(（]1[\)）]$/, '').trim();
                    itemName = itemName.replace(new RegExp(`[\\(（]1[${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                    itemName = itemName.replace(new RegExp(`[\\(（][${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                    
                    const atIndex = rest.indexOf('@');
                    const itemInfo = {
                        icon: icon,
                        importance: importance,
                        holder: atIndex >= 0 ? (rest.substring(0, atIndex).trim() || null) : (rest || null),
                        location: atIndex >= 0 ? (rest.substring(atIndex + 1).trim() || '') : ''
                    };
                    if (description !== undefined) itemInfo.description = description;
                    result.items[itemName] = itemInfo;
                }
            }
            // event:重要|爱丽丝坦白了秘密
            else if (trimmedLine.startsWith('event:')) {
                const eventStr = trimmedLine.substring(6).trim();
                const parts = eventStr.split('|');
                if (parts.length >= 2) {
                    const levelRaw = parts[0].trim();
                    const summary = parts.slice(1).join('|').trim();
                    
                    let level = '一般';
                    if (levelRaw === '关键' || levelRaw === '關鍵' || levelRaw.toLowerCase() === 'critical') {
                        level = '关键';
                    } else if (levelRaw === '重要' || levelRaw.toLowerCase() === 'important') {
                        level = '重要';
                    }
                    
                    result.events.push({
                        is_important: level === '重要' || level === '关键',
                        level: level,
                        summary: summary
                    });
                }
            }
            // affection:鲍勃=65 或 affection:鲍勃+5（兼容新旧格式）
            // 容忍AI附加注解如 affection:汤姆=18(+0)|观察到xxx，只提取名字和数值
            else if (trimmedLine.startsWith('affection:')) {
                const affStr = trimmedLine.substring(10).trim();
                // 新格式：角色名=数值（绝对值，允许带正负号如 =+28 或 =-15）
                const absoluteMatch = affStr.match(/^(.+?)=\s*([+\-]?\d+\.?\d*)/);
                if (absoluteMatch) {
                    const key = absoluteMatch[1].trim();
                    const value = parseFloat(absoluteMatch[2]);
                    result.affection[key] = { type: 'absolute', value: value };
                } else {
                    // 旧格式：角色名+/-数值（相对值，无=号）— 允许数值后跟任意注解
                    const relativeMatch = affStr.match(/^(.+?)([+\-]\d+\.?\d*)/);
                    if (relativeMatch) {
                        const key = relativeMatch[1].trim();
                        const value = relativeMatch[2];
                        result.affection[key] = { type: 'relative', value: value };
                    }
                }
            }
            // npc:名|外貌=性格@关系~性别:男~年龄:25~种族:人类~职业:佣兵~补充:xxx
            // 使用 ~ 分隔扩展字段（key:value），不依赖顺序
            else if (trimmedLine.startsWith('npc:')) {
                const npcStr = trimmedLine.substring(4).trim();
                const npcInfo = this._parseNpcFields(npcStr);
                const name = npcInfo._name;
                delete npcInfo._name;
                
                if (name) {
                    npcInfo.last_seen = new Date().toISOString();
                    if (!result.npcs[name]) {
                        npcInfo.first_seen = new Date().toISOString();
                    }
                    result.npcs[name] = npcInfo;
                }
            }
            // agenda-:已完成待办内容 / agenda:订立日期|内容
            else if (trimmedLine.startsWith('agenda-:')) {
                const delStr = trimmedLine.substring(8).trim();
                if (delStr) {
                    const pipeIdx = delStr.indexOf('|');
                    const text = pipeIdx > 0 ? delStr.substring(pipeIdx + 1).trim() : delStr;
                    if (text) {
                        result.deletedAgenda.push(text);
                    }
                }
            }
            else if (trimmedLine.startsWith('agenda:')) {
                const agendaStr = trimmedLine.substring(7).trim();
                const pipeIdx = agendaStr.indexOf('|');
                let dateStr = '', text = '';
                if (pipeIdx > 0) {
                    dateStr = agendaStr.substring(0, pipeIdx).trim();
                    text = agendaStr.substring(pipeIdx + 1).trim();
                } else {
                    text = agendaStr;
                }
                if (text) {
                    // 检测 AI 用括号标记完成的情况，自动归入 deletedAgenda
                    const doneMatch = text.match(/[\(（](完成|已完成|done|finished|completed|失效|取消|已取消)[\)）]\s*$/i);
                    if (doneMatch) {
                        const cleanText = text.substring(0, text.length - doneMatch[0].length).trim();
                        if (cleanText) result.deletedAgenda.push(cleanText);
                    } else {
                        result.agenda.push({ date: dateStr, text, source: 'ai', done: false });
                    }
                }
            }
            // rel:角色A>角色B=关系类型|备注
            else if (trimmedLine.startsWith('rel:')) {
                const relStr = trimmedLine.substring(4).trim();
                const arrowIdx = relStr.indexOf('>');
                const eqIdx = relStr.indexOf('=');
                if (arrowIdx > 0 && eqIdx > arrowIdx) {
                    const from = relStr.substring(0, arrowIdx).trim();
                    const to = relStr.substring(arrowIdx + 1, eqIdx).trim();
                    const rest = relStr.substring(eqIdx + 1).trim();
                    const pipeIdx = rest.indexOf('|');
                    const type = pipeIdx > 0 ? rest.substring(0, pipeIdx).trim() : rest;
                    const note = pipeIdx > 0 ? rest.substring(pipeIdx + 1).trim() : '';
                    if (from && to && type) {
                        result.relationships.push({ from, to, type, note });
                    }
                }
            }
            // mood:角色名=情绪状态
            else if (trimmedLine.startsWith('mood:')) {
                const moodStr = trimmedLine.substring(5).trim();
                const eqIdx = moodStr.indexOf('=');
                if (eqIdx > 0) {
                    const charName = moodStr.substring(0, eqIdx).trim();
                    const emotion = moodStr.substring(eqIdx + 1).trim();
                    if (charName && emotion) {
                        result.mood[charName] = emotion;
                    }
                }
            }
        }

        // 解析自定义表格数据
        if (tableMatches.length > 0) {
            result.tableUpdates = [];
            for (const tm of tableMatches) {
                const tableName = tm[1].trim();
                const tableContent = tm[2].trim();
                const updates = this._parseTableCellEntries(tableContent);
                
                if (Object.keys(updates).length > 0) {
                    result.tableUpdates.push({ name: tableName, updates });
                }
            }
        }

        // 解析 RPG 数据
        if (rpgMatches.length > 0) {
            result.rpg = { bars: {}, status: {}, skills: [], removedSkills: [], attributes: {}, reputation: {}, equipment: [], unequip: [], levels: {}, xp: {}, currency: [], baseChanges: [] };
            for (const rm of rpgMatches) {
                const rpgContent = rm[1].trim();
                for (const rpgLine of rpgContent.split('\n')) {
                    const trimmed = rpgLine.trim();
                    if (trimmed) this._parseRpgLine(trimmed, result.rpg);
                }
            }
        }

        return result;
    }

    /** 将解析结果合并到元数据 */
    mergeParsedToMeta(baseMeta, parsed) {
        const meta = baseMeta ? JSON.parse(JSON.stringify(baseMeta)) : createEmptyMeta();
        
        if (parsed.timestamp?.story_date) {
            meta.timestamp.story_date = parsed.timestamp.story_date;
        }
        if (parsed.timestamp?.story_time) {
            meta.timestamp.story_time = parsed.timestamp.story_time;
        }
        meta.timestamp.absolute = new Date().toISOString();
        
        if (parsed.scene?.location) {
            meta.scene.location = parsed.scene.location;
        }
        if (parsed.scene?.atmosphere) {
            meta.scene.atmosphere = parsed.scene.atmosphere;
        }
        if (parsed.scene?.scene_desc) {
            meta.scene.scene_desc = parsed.scene.scene_desc;
        }
        if (parsed.scene?.characters_present?.length > 0) {
            meta.scene.characters_present = parsed.scene.characters_present;
        }
        
        if (parsed.costumes) {
            Object.assign(meta.costumes, parsed.costumes);
        }
        
        if (parsed.items) {
            Object.assign(meta.items, parsed.items);
        }
        
        if (parsed.deletedItems && parsed.deletedItems.length > 0) {
            if (!meta.deletedItems) meta.deletedItems = [];
            meta.deletedItems = [...new Set([...meta.deletedItems, ...parsed.deletedItems])];
        }
        
        // 支持新格式（events数组）和旧格式（单个event）
        if (parsed.events && parsed.events.length > 0) {
            meta.events = parsed.events;
        } else if (parsed.event) {
            // 兼容旧格式：转换为数组
            meta.events = [parsed.event];
        }
        
        if (parsed.affection) {
            Object.assign(meta.affection, parsed.affection);
        }
        
        if (parsed.npcs) {
            Object.assign(meta.npcs, parsed.npcs);
        }
        
        // 追加AI写入的待办（跳过用户已手动删除的）
        if (parsed.agenda && parsed.agenda.length > 0) {
            if (!meta.agenda) meta.agenda = [];
            const chat0 = this.getChat()?.[0];
            const deletedSet = new Set(chat0?.horae_meta?._deletedAgendaTexts || []);
            for (const item of parsed.agenda) {
                if (deletedSet.has(item.text)) continue;
                const isDupe = meta.agenda.some(a => a.text === item.text);
                if (!isDupe) {
                    meta.agenda.push(item);
                }
            }
        }
        
        // 关系网络：存入当前消息（后续由 processAIResponse 合并到 chat[0]）
        if (parsed.relationships && parsed.relationships.length > 0) {
            if (!meta.relationships) meta.relationships = [];
            meta.relationships = parsed.relationships;
        }
        
        // 情绪状态
        if (parsed.mood && Object.keys(parsed.mood).length > 0) {
            if (!meta.mood) meta.mood = {};
            Object.assign(meta.mood, parsed.mood);
        }
        
        // tableUpdates 作为副属性传递
        if (parsed.tableUpdates) {
            meta._tableUpdates = parsed.tableUpdates;
        }
        
        if (parsed.rpg) {
            const r = parsed.rpg;
            const hasContent = Object.keys(r.bars || {}).length > 0
                || Object.keys(r.status || {}).length > 0
                || (r.skills || []).length > 0
                || (r.removedSkills || []).length > 0
                || Object.keys(r.attributes || {}).length > 0
                || Object.keys(r.reputation || {}).length > 0
                || (r.equipment || []).length > 0
                || (r.unequip || []).length > 0
                || Object.keys(r.levels || {}).length > 0
                || Object.keys(r.xp || {}).length > 0
                || (r.currency || []).length > 0
                || (r.baseChanges || []).length > 0;
            if (hasContent) {
                meta._rpgChanges = parsed.rpg;
            }
        }
        
        return meta;
    }

    /** 解析单行 RPG 数据 */
    _parseRpgLine(line, rpg) {
        const _uoName = this.context?.name1 || '主角';
        const _uoB = !!this.settings?.rpgBarsUserOnly;
        const _uoS = !!this.settings?.rpgSkillsUserOnly;
        const _uoA = !!this.settings?.rpgAttrsUserOnly;
        const _uoE = !!this.settings?.rpgEquipmentUserOnly;
        const _uoR = !!this.settings?.rpgReputationUserOnly;
        const _uoL = !!this.settings?.rpgLevelUserOnly;
        const _uoC = !!this.settings?.rpgCurrencyUserOnly;

        // 通用：检测行是否为无owner的userOnly格式（首段含=即正常格式，否则可能是UO格式）
        // 属性条: 正常 key:owner=cur/max 或 userOnly key:cur/max(显示名)
        const barNormal = line.match(/^([a-zA-Z]\w*):(.+?)=(\d+)\s*\/\s*(\d+)(?:\((.+?)\))?$/i);
        const barUo = _uoB ? line.match(/^([a-zA-Z]\w*):(\d+)\s*\/\s*(\d+)(?:\((.+?)\))?$/i) : null;
        if (barNormal && !/^(status|skill)$/i.test(barNormal[1])) {
            const type = barNormal[1].toLowerCase();
            const owner = _uoB ? _uoName : barNormal[2].trim();
            const current = parseInt(barNormal[3]);
            const max = parseInt(barNormal[4]);
            const label = barNormal[5]?.trim() || null;
            if (!rpg.bars[owner]) rpg.bars[owner] = {};
            rpg.bars[owner][type] = label ? [current, max, label] : [current, max];
            return;
        }
        if (barUo && !/^(status|skill)$/i.test(barUo[1])) {
            const type = barUo[1].toLowerCase();
            const current = parseInt(barUo[2]);
            const max = parseInt(barUo[3]);
            const label = barUo[4]?.trim() || null;
            if (!rpg.bars[_uoName]) rpg.bars[_uoName] = {};
            rpg.bars[_uoName][type] = label ? [current, max, label] : [current, max];
            return;
        }
        // status
        if (line.startsWith('status:')) {
            const str = line.substring(7).trim();
            const eq = str.indexOf('=');
            if (_uoB && eq < 0) {
                rpg.status[_uoName] = (!str || /^(正常|无|無|none|normal|clear)$/i.test(str))
                    ? [] : str.split('/').map(s => s.trim()).filter(Boolean);
            } else if (eq > 0) {
                const owner = _uoB ? _uoName : str.substring(0, eq).trim();
                const val = str.substring(eq + 1).trim();
                rpg.status[owner] = (!val || /^(正常|无|無|none|normal|clear)$/i.test(val))
                    ? [] : val.split('/').map(s => s.trim()).filter(Boolean);
            }
            return;
        }
        // skill
        if (line.startsWith('skill:')) {
            const parts = line.substring(6).trim().split('|').map(s => s.trim());
            if (_uoS && parts.length >= 1) {
                rpg.skills.push({ owner: _uoName, name: parts[0], level: parts[1] || '', desc: parts[2] || '' });
            } else if (parts.length >= 2) {
                rpg.skills.push({ owner: parts[0], name: parts[1], level: parts[2] || '', desc: parts[3] || '' });
            }
            return;
        }
        // skill-
        if (line.startsWith('skill-:')) {
            const parts = line.substring(7).trim().split('|').map(s => s.trim());
            if (_uoS && parts.length >= 1) {
                rpg.removedSkills.push({ owner: _uoName, name: parts[0] });
            } else if (parts.length >= 2) {
                rpg.removedSkills.push({ owner: parts[0], name: parts[1] });
            }
            return;
        }
        // equip
        if (line.startsWith('equip:')) {
            const parts = line.substring(6).trim().split('|').map(s => s.trim());
            const minParts = _uoE ? 2 : 3;
            if (parts.length >= minParts) {
                const owner = _uoE ? _uoName : parts[0];
                const slot = _uoE ? parts[0] : parts[1];
                const itemName = _uoE ? parts[1] : parts[2];
                const attrPart = _uoE ? parts[2] : parts[3];
                const attrs = {};
                if (attrPart) {
                    for (const kv of attrPart.split(',')) {
                        const m = kv.trim().match(/^(.+?)=(-?\d+)$/);
                        if (m) attrs[m[1].trim()] = parseInt(m[2]);
                    }
                }
                if (!rpg.equipment) rpg.equipment = [];
                rpg.equipment.push({ owner, slot, name: itemName, attrs });
            }
            return;
        }
        // unequip
        if (line.startsWith('unequip:')) {
            const parts = line.substring(8).trim().split('|').map(s => s.trim());
            const minParts = _uoE ? 2 : 3;
            if (parts.length >= minParts) {
                if (!rpg.unequip) rpg.unequip = [];
                if (_uoE) {
                    rpg.unequip.push({ owner: _uoName, slot: parts[0], name: parts[1] });
                } else {
                    rpg.unequip.push({ owner: parts[0], slot: parts[1], name: parts[2] });
                }
            }
            return;
        }
        // rep
        if (line.startsWith('rep:')) {
            const parts = line.substring(4).trim().split('|').map(s => s.trim());
            if (_uoR && parts.length >= 1) {
                const kv = parts[0].match(/^(.+?)=(-?\d+)$/);
                if (kv) {
                    if (!rpg.reputation) rpg.reputation = {};
                    if (!rpg.reputation[_uoName]) rpg.reputation[_uoName] = {};
                    rpg.reputation[_uoName][kv[1].trim()] = parseInt(kv[2]);
                }
            } else if (parts.length >= 2) {
                const owner = parts[0];
                const kv = parts[1].match(/^(.+?)=(-?\d+)$/);
                if (kv) {
                    if (!rpg.reputation) rpg.reputation = {};
                    if (!rpg.reputation[owner]) rpg.reputation[owner] = {};
                    rpg.reputation[owner][kv[1].trim()] = parseInt(kv[2]);
                }
            }
            return;
        }
        // level
        if (line.startsWith('level:')) {
            const str = line.substring(6).trim();
            if (_uoL) {
                const val = parseInt(str);
                if (!isNaN(val)) {
                    if (!rpg.levels) rpg.levels = {};
                    rpg.levels[_uoName] = val;
                }
            } else {
                const eq = str.indexOf('=');
                if (eq > 0) {
                    const owner = str.substring(0, eq).trim();
                    const val = parseInt(str.substring(eq + 1).trim());
                    if (!isNaN(val)) {
                        if (!rpg.levels) rpg.levels = {};
                        rpg.levels[owner] = val;
                    }
                }
            }
            return;
        }
        // xp
        if (line.startsWith('xp:')) {
            const str = line.substring(3).trim();
            if (_uoL) {
                const m = str.match(/^(\d+)\s*\/\s*(\d+)$/);
                if (m) {
                    if (!rpg.xp) rpg.xp = {};
                    rpg.xp[_uoName] = [parseInt(m[1]), parseInt(m[2])];
                }
            } else {
                const eq = str.indexOf('=');
                if (eq > 0) {
                    const owner = str.substring(0, eq).trim();
                    const valStr = str.substring(eq + 1).trim();
                    const m = valStr.match(/^(\d+)\s*\/\s*(\d+)$/);
                    if (m) {
                        if (!rpg.xp) rpg.xp = {};
                        rpg.xp[owner] = [parseInt(m[1]), parseInt(m[2])];
                    }
                }
            }
            return;
        }
        // currency
        if (line.startsWith('currency:')) {
            const parts = line.substring(9).trim().split('|').map(s => s.trim());
            if (_uoC && parts.length >= 1) {
                const kvStr = parts.length >= 2 ? parts[1] : parts[0];
                const kv = kvStr.match(/^(.+?)=([+-]?\d+)$/);
                if (kv) {
                    if (!rpg.currency) rpg.currency = [];
                    const rawVal = kv[2];
                    const isDelta = rawVal.startsWith('+') || rawVal.startsWith('-');
                    rpg.currency.push({ owner: _uoName, name: kv[1].trim(), value: parseInt(rawVal), isDelta });
                }
            } else if (parts.length >= 2) {
                const owner = parts[0];
                const kv = parts[1].match(/^(.+?)=([+-]?\d+)$/);
                if (kv) {
                    if (!rpg.currency) rpg.currency = [];
                    const rawVal = kv[2];
                    const isDelta = rawVal.startsWith('+') || rawVal.startsWith('-');
                    rpg.currency.push({ owner, name: kv[1].trim(), value: parseInt(rawVal), isDelta });
                }
            }
            return;
        }
        // attr
        if (line.startsWith('attr:')) {
            const parts = line.substring(5).trim().split('|').map(s => s.trim());
            if (parts.length >= 1) {
                let owner, startIdx;
                if (_uoA) {
                    owner = _uoName;
                    startIdx = 0;
                } else {
                    owner = parts[0];
                    startIdx = 1;
                }
                const vals = {};
                for (let i = startIdx; i < parts.length; i++) {
                    const kv = parts[i].match(/^(\w+)=(\d+)$/);
                    if (kv) vals[kv[1].toLowerCase()] = parseInt(kv[2]);
                }
                if (Object.keys(vals).length) {
                    if (!rpg.attributes) rpg.attributes = {};
                    rpg.attributes[owner] = vals;
                }
            }
            return;
        }
        // base:据点路径=等级 或 base:据点路径|desc=描述
        // 路径用 > 分隔层级，如 base:主角庄园>锻造区>锻造炉=2
        if (line.startsWith('base:')) {
            if (!rpg.baseChanges) rpg.baseChanges = [];
            const raw = line.substring(5).trim();
            const pipeIdx = raw.indexOf('|');
            if (pipeIdx >= 0) {
                const path = raw.substring(0, pipeIdx).trim();
                const rest = raw.substring(pipeIdx + 1).trim();
                const kv = rest.match(/^(desc|level)=(.+)$/);
                if (kv) {
                    rpg.baseChanges.push({ path, field: kv[1], value: kv[2].trim() });
                }
            } else {
                const eqIdx = raw.indexOf('=');
                if (eqIdx >= 0) {
                    const path = raw.substring(0, eqIdx).trim();
                    const val = raw.substring(eqIdx + 1).trim();
                    const numVal = parseInt(val);
                    if (!isNaN(numVal)) {
                        rpg.baseChanges.push({ path, field: 'level', value: numVal });
                    } else {
                        rpg.baseChanges.push({ path, field: 'desc', value: val });
                    }
                }
            }
        }
    }

    /** 解析归属者：优先 N 编号 → 占位符替换 → NPC/user 别名反查 */
    _resolveRpgOwner(ownerStr) {
        if (ownerStr == null) return ownerStr;
        let raw = String(ownerStr).trim();
        if (!raw) return raw;

        const _user = this.context?.name1 || '';
        const _char = this.context?.name2 || '';
        if (_user) raw = raw.replace(/\{\{\s*user\s*\}\}/gi, _user);
        if (_char) raw = raw.replace(/\{\{\s*char\s*\}\}/gi, _char);

        const m = raw.match(/^N(\d+)\s+(.+)$/);
        if (m) {
            const npcId = m[1];
            const padded = padItemId(parseInt(npcId, 10));
            const chat = this.getChat();
            for (let i = chat.length - 1; i >= 0; i--) {
                const npcs = chat[i]?.horae_meta?.npcs;
                if (!npcs) continue;
                for (const [name, info] of Object.entries(npcs)) {
                    if (String(info._id) === npcId || info._id === padded) return name;
                }
            }
            raw = m[2].trim();
        }

        const chat = this.getChat();
        if (chat?.length) {
            for (let i = chat.length - 1; i >= 0; i--) {
                const npcs = chat[i]?.horae_meta?.npcs;
                if (!npcs) continue;
                if (npcs[raw]) return raw;
                for (const [name, info] of Object.entries(npcs)) {
                    if (info?._aliases?.includes(raw)) return name;
                }
            }
            const userAliases = chat[0]?.horae_meta?._userAliases;
            if (_user && Array.isArray(userAliases) && userAliases.includes(raw)) {
                return _user;
            }
        }

        return raw;
    }

    /** 合并 RPG 变更到 chat[0].horae_meta.rpg
     *  @param {boolean} [readOnly=false] rebuild 路径设为 true，跳过物品转移等破坏性操作
     */
    _mergeRpgData(changes, readOnly = false) {
        const chat = this.getChat();
        if (!chat?.length || !changes) return;
        const first = chat[0];
        if (!first.horae_meta) first.horae_meta = createEmptyMeta();
        if (!first.horae_meta.rpg) first.horae_meta.rpg = { bars: {}, status: {}, skills: {} };
        const rpg = first.horae_meta.rpg;

        const _mUN = this.context?.name1 || '主角';

        for (const [raw, barData] of Object.entries(changes.bars || {})) {
            const owner = this._resolveRpgOwner(raw);
            if (this.settings?.rpgBarsUserOnly && owner !== _mUN) continue;
            if (!rpg.bars[owner]) rpg.bars[owner] = {};
            Object.assign(rpg.bars[owner], barData);
        }
        for (const [raw, effects] of Object.entries(changes.status || {})) {
            const owner = this._resolveRpgOwner(raw);
            if (this.settings?.rpgBarsUserOnly && owner !== _mUN) continue;
            if (!rpg.status) rpg.status = {};
            rpg.status[owner] = effects;
        }
        const _deletedSkillSet = new Set((rpg._deletedSkills || []).map(d => `${d.owner}\0${d.name}`));
        for (const sk of (changes.skills || [])) {
            const owner = this._resolveRpgOwner(sk.owner);
            if (this.settings?.rpgSkillsUserOnly && owner !== _mUN) continue;
            if (_deletedSkillSet.has(`${owner}\0${sk.name}`)) continue;
            if (!rpg.skills[owner]) rpg.skills[owner] = [];
            const idx = rpg.skills[owner].findIndex(s => s.name === sk.name);
            if (idx >= 0) {
                if (sk.level != null) rpg.skills[owner][idx].level = sk.level;
                if (sk.desc != null) rpg.skills[owner][idx].desc = sk.desc;
            } else {
                rpg.skills[owner].push({ name: sk.name, level: sk.level, desc: sk.desc });
            }
        }
        for (const sk of (changes.removedSkills || [])) {
            const owner = this._resolveRpgOwner(sk.owner);
            if (this.settings?.rpgSkillsUserOnly && owner !== _mUN) continue;
            if (rpg.skills[owner]) {
                rpg.skills[owner] = rpg.skills[owner].filter(s => s.name !== sk.name);
            }
        }
        // 多维属性
        for (const [raw, vals] of Object.entries(changes.attributes || {})) {
            const owner = this._resolveRpgOwner(raw);
            if (this.settings?.rpgAttrsUserOnly && owner !== _mUN) continue;
            if (!rpg.attributes) rpg.attributes = {};
            rpg.attributes[owner] = { ...(rpg.attributes[owner] || {}), ...vals };
        }
        // 装备：按角色独立格位配置
        if (changes.equipment?.length > 0 || changes.unequip?.length > 0) {
            if (!rpg.equipmentConfig) rpg.equipmentConfig = { locked: false, perChar: {} };
            if (!rpg.equipmentConfig.perChar) rpg.equipmentConfig.perChar = {};
            if (!rpg.equipment) rpg.equipment = {};
            const _getOwnerSlots = (owner) => {
                const pc = rpg.equipmentConfig.perChar[owner];
                if (!pc || !Array.isArray(pc.slots)) return { valid: new Set(), deleted: new Set(), maxMap: {} };
                return {
                    valid: new Set(pc.slots.map(s => s.name)),
                    deleted: new Set(pc._deletedSlots || []),
                    maxMap: Object.fromEntries(pc.slots.map(s => [s.name, s.maxCount ?? 1])),
                };
            };
            const _findAndTakeItem = (name) => {
                if (readOnly) return null;
                const state = this.getLatestState();
                const itemInfo = state?.items?.[name];
                if (!itemInfo) return null;
                const meta = { icon: itemInfo.icon || '', description: itemInfo.description || '', importance: itemInfo.importance || '', _id: itemInfo._id || '', _locked: itemInfo._locked || false };
                for (let k = chat.length - 1; k >= 0; k--) {
                    if (chat[k]?.horae_meta?.items?.[name]) { delete chat[k].horae_meta.items[name]; break; }
                }
                return meta;
            };
            const _returnItemFromEquip = (entry, owner) => {
                if (readOnly) return;
                if (!first.horae_meta.items) first.horae_meta.items = {};
                const m = entry._itemMeta || {};
                first.horae_meta.items[entry.name] = {
                    icon: m.icon || '📦', description: m.description || '', importance: m.importance || '',
                    holder: owner, location: '', _id: m._id || '', _locked: m._locked || false,
                };
            };
            for (const u of (changes.unequip || [])) {
                const owner = this._resolveRpgOwner(u.owner);
                if (this.settings?.rpgEquipmentUserOnly && owner !== _mUN) continue;
                if (!rpg.equipment[owner]?.[u.slot]) continue;
                const removed = rpg.equipment[owner][u.slot].find(e => e.name === u.name);
                rpg.equipment[owner][u.slot] = rpg.equipment[owner][u.slot].filter(e => e.name !== u.name);
                if (removed) _returnItemFromEquip(removed, owner);
                if (!rpg.equipment[owner][u.slot].length) delete rpg.equipment[owner][u.slot];
                if (rpg.equipment[owner] && !Object.keys(rpg.equipment[owner]).length) delete rpg.equipment[owner];
            }
            for (const eq of (changes.equipment || [])) {
                const slotName = eq.slot;
                const owner = this._resolveRpgOwner(eq.owner);
                if (this.settings?.rpgEquipmentUserOnly && owner !== _mUN) continue;
                const { valid, deleted, maxMap } = _getOwnerSlots(owner);
                if (valid.size > 0 && (!valid.has(slotName) || deleted.has(slotName))) continue;
                if (!rpg.equipment[owner]) rpg.equipment[owner] = {};
                if (!rpg.equipment[owner][slotName]) rpg.equipment[owner][slotName] = [];
                const existing = rpg.equipment[owner][slotName].findIndex(e => e.name === eq.name);
                if (existing >= 0) {
                    rpg.equipment[owner][slotName][existing].attrs = eq.attrs;
                } else {
                    const maxCount = maxMap[slotName] ?? 1;
                    if (rpg.equipment[owner][slotName].length >= maxCount) {
                        const bumped = rpg.equipment[owner][slotName].shift();
                        if (bumped) _returnItemFromEquip(bumped, owner);
                    }
                    const itemMeta = _findAndTakeItem(eq.name);
                    rpg.equipment[owner][slotName].push({ name: eq.name, attrs: eq.attrs || {}, ...(itemMeta ? { _itemMeta: itemMeta } : {}) });
                }
            }
        }
        // 声望：只接受 reputationConfig 中已定义且未删除的分类（配置为空时不限制）
        if (changes.reputation && Object.keys(changes.reputation).length > 0) {
            const _cfgs = this.getChat()?.[0]?.horae_meta?._rpgConfigs;
            const repCfg = _cfgs?.reputationConfig || rpg.reputationConfig || { categories: [], _deletedCategories: [] };
            if (!rpg.reputationConfig) rpg.reputationConfig = repCfg;
            if (!rpg.reputation) rpg.reputation = {};
            const validNames = new Set((repCfg.categories || []).map(c => c.name));
            const deleted = new Set(repCfg._deletedCategories || []);
            for (const [raw, cats] of Object.entries(changes.reputation)) {
                const owner = this._resolveRpgOwner(raw);
                if (this.settings?.rpgReputationUserOnly && owner !== _mUN) continue;
                if (!rpg.reputation[owner]) rpg.reputation[owner] = {};
                for (const [catName, val] of Object.entries(cats)) {
                    if (deleted.has(catName)) continue;
                    if (validNames.size > 0 && !validNames.has(catName)) continue;
                    const cfg = rpg.reputationConfig.categories.find(c => c.name === catName);
                    const clamped = Math.max(cfg?.min ?? -100, Math.min(cfg?.max ?? 100, val));
                    if (!rpg.reputation[owner][catName]) {
                        rpg.reputation[owner][catName] = { value: clamped, subItems: {} };
                    } else if (!rpg.reputation[owner][catName]._userEdited) {
                        rpg.reputation[owner][catName].value = clamped;
                    }
                }
            }
        }
        // 等级
        for (const [raw, val] of Object.entries(changes.levels || {})) {
            const owner = this._resolveRpgOwner(raw);
            if (this.settings?.rpgLevelUserOnly && owner !== _mUN) continue;
            if (!rpg.levels) rpg.levels = {};
            rpg.levels[owner] = val;
        }
        // 经验值
        for (const [raw, val] of Object.entries(changes.xp || {})) {
            const owner = this._resolveRpgOwner(raw);
            if (this.settings?.rpgLevelUserOnly && owner !== _mUN) continue;
            if (!rpg.xp) rpg.xp = {};
            rpg.xp[owner] = val;
        }
        // 货币：只接受 currencyConfig 中已定义的币种（配置为空时不限制）
        if (changes.currency?.length > 0) {
            const _cfgs2 = this.getChat()?.[0]?.horae_meta?._rpgConfigs;
            const curCfg = _cfgs2?.currencyConfig || rpg.currencyConfig || { denominations: [] };
            if (!rpg.currencyConfig) rpg.currencyConfig = curCfg;
            if (!rpg.currency) rpg.currency = {};
            const validDenoms = new Set((curCfg.denominations || []).map(d => d.name));
            for (const c of changes.currency) {
                const owner = this._resolveRpgOwner(c.owner);
                if (this.settings?.rpgCurrencyUserOnly && owner !== _mUN) continue;
                if (validDenoms.size > 0 && !validDenoms.has(c.name)) continue;
                if (!rpg.currency[owner]) rpg.currency[owner] = {};
                if (c.isDelta) {
                    rpg.currency[owner][c.name] = (rpg.currency[owner][c.name] || 0) + c.value;
                } else {
                    rpg.currency[owner][c.name] = c.value;
                }
            }
        }
        // 据点变更（跳过用户已删除的节点，防回滚）
        if (changes.baseChanges?.length > 0) {
            if (!rpg.strongholds) rpg.strongholds = [];
            const deletedSh = rpg._deletedStrongholds || [];
            for (const bc of changes.baseChanges) {
                const pathParts = bc.path.split('>').map(s => s.trim()).filter(Boolean);
                let parentId = null;
                let targetNode = null;
                let blocked = false;
                for (const part of pathParts) {
                    const parentName = parentId ? (rpg.strongholds.find(n => n.id === parentId)?.name || null) : null;
                    if (deletedSh.some(d => d.name === part && (d.parent || null) === parentName)) {
                        blocked = true;
                        break;
                    }
                    targetNode = rpg.strongholds.find(n => n.name === part && (n.parent || null) === parentId);
                    if (!targetNode) {
                        targetNode = { id: 'sh_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: part, level: null, desc: '', parent: parentId };
                        rpg.strongholds.push(targetNode);
                    }
                    parentId = targetNode.id;
                }
                if (blocked || !targetNode) continue;
                if (bc.field === 'level') targetNode.level = typeof bc.value === 'number' ? bc.value : parseInt(bc.value);
                else if (bc.field === 'desc') targetNode.desc = String(bc.value);
            }
        }
    }

    /** 从所有消息重建 RPG 全局数据（保留用户手动编辑）
     *  config 从 horae_meta._rpgConfigs（顶层键）读取，不依赖 rpg 内部字段。
     */
    rebuildRpgData() {
        const chat = this.getChat();
        if (!chat?.length) return;
        const first = chat[0];
        if (!first.horae_meta) first.horae_meta = createEmptyMeta();
        if (!first.horae_meta.rpg) first.horae_meta.rpg = {};
        const rpg = first.horae_meta.rpg;

        // ── 从 _rpgConfigs 权威来源读取 config，fallback 到 rpg 内部（旧数据迁移） ──
        const cfgs = first.horae_meta._rpgConfigs || {};
        const repCfg = cfgs.reputationConfig || rpg.reputationConfig || { categories: [], _deletedCategories: [] };
        const eqCfg = cfgs.equipmentConfig || rpg.equipmentConfig || { locked: false, perChar: {} };
        const curCfg = cfgs.currencyConfig || rpg.currencyConfig || { denominations: [] };
        const shs = cfgs.strongholds || rpg.strongholds || [];
        const delShs = cfgs._deletedStrongholds || rpg._deletedStrongholds || [];
        const delSkills = cfgs._deletedSkills || rpg._deletedSkills || [];

        // ── 保留用户手动数据 ──
        const userSkills = {};
        for (const [owner, arr] of Object.entries(rpg.skills || {})) {
            const ua = (arr || []).filter(s => s._userAdded);
            if (ua.length) userSkills[owner] = ua;
        }
        const userAttrs = rpg.attributes || {};
        const oldReputation = rpg.reputation ? JSON.parse(JSON.stringify(rpg.reputation)) : {};

        // ── 只重置可重放的数据字段 ──
        rpg.bars = {};
        rpg.status = {};
        rpg.skills = {};
        rpg.attributes = { ...userAttrs };
        rpg.reputation = {};
        rpg.equipment = {};
        rpg.levels = {};
        rpg.xp = {};
        rpg.currency = {};

        // ── config 从权威来源写入 rpg（供 _mergeRpgData 使用） ──
        rpg.reputationConfig = repCfg;
        rpg.equipmentConfig = eqCfg;
        rpg.currencyConfig = curCfg;
        rpg._deletedSkills = delSkills;
        rpg.strongholds = JSON.parse(JSON.stringify(shs));
        rpg._deletedStrongholds = JSON.parse(JSON.stringify(delShs));

        // ── 从所有消息重放 _rpgChanges ──
        for (let i = 0; i < chat.length; i++) {
            const changes = chat[i]?.horae_meta?._rpgChanges;
            if (changes) this._mergeRpgData(changes, true);
        }

        // ── 回填用户手动添加的技能 ──
        for (const [owner, arr] of Object.entries(userSkills)) {
            if (!rpg.skills[owner]) rpg.skills[owner] = [];
            for (const sk of arr) {
                if (!rpg.skills[owner].some(s => s.name === sk.name)) rpg.skills[owner].push(sk);
            }
        }
        for (const del of delSkills) {
            if (rpg.skills[del.owner]) {
                rpg.skills[del.owner] = rpg.skills[del.owner].filter(s => s.name !== del.name);
                if (!rpg.skills[del.owner].length) delete rpg.skills[del.owner];
            }
        }

        // ── 回填用户设置的声望 ──
        const deletedRepCats = new Set(rpg.reputationConfig?._deletedCategories || []);
        const validRepCats = new Set((rpg.reputationConfig?.categories || []).map(c => c.name));
        for (const [owner, cats] of Object.entries(oldReputation)) {
            if (!rpg.reputation[owner]) rpg.reputation[owner] = {};
            for (const [catName, data] of Object.entries(cats)) {
                if (deletedRepCats.has(catName)) continue;
                if (validRepCats.size > 0 && !validRepCats.has(catName)) continue;
                if (!rpg.reputation[owner][catName]) {
                    rpg.reputation[owner][catName] = data;
                } else {
                    rpg.reputation[owner][catName].subItems = data.subItems || {};
                    if (data._userEdited) {
                        rpg.reputation[owner][catName].value = data.value;
                        rpg.reputation[owner][catName]._userEdited = true;
                    }
                }
            }
        }

        // ── 同步回 _rpgConfigs 权威存储 ──
        first.horae_meta._rpgConfigs = {
            reputationConfig: rpg.reputationConfig,
            equipmentConfig: rpg.equipmentConfig,
            currencyConfig: rpg.currencyConfig,
            _deletedSkills: rpg._deletedSkills,
            strongholds: rpg.strongholds,
            _deletedStrongholds: rpg._deletedStrongholds,
        };
    }

    /** 获取 RPG 全局数据（chat[0] 累积） */
    getRpgData() {
        return this.getChat()?.[0]?.horae_meta?.rpg || {
            bars: {}, status: {}, skills: {}, attributes: {},
            reputation: {}, reputationConfig: { categories: [], _deletedCategories: [] },
            equipment: {}, equipmentConfig: { locked: false, perChar: {} },
            levels: {}, xp: {},
            currency: {}, currencyConfig: { denominations: [] },
        };
    }

    /**
     * 构建到指定消息位置的 RPG 快照（不修改 chat[0]）
     * @param {number} skipLast - 跳过末尾N条消息（swipe时=1）
     */
    getRpgStateAt(skipLast = 0) {
        const chat = this.getChat();
        if (!chat?.length) return { bars: {}, status: {}, skills: {}, attributes: {}, reputation: {}, equipment: {}, levels: {}, xp: {}, currency: {}, strongholds: [] };
        const end = Math.max(1, chat.length - skipLast);
        const first = chat[0];
        const rpgMeta = first?.horae_meta?.rpg || {};
        const _cfgs = first?.horae_meta?._rpgConfigs || {};
        // 据点：优先从 _rpgConfigs 读取
        const userStrongholds = (_cfgs.strongholds || rpgMeta.strongholds || []).filter(n => n._userAdded);
        const deletedSh = _cfgs._deletedStrongholds || rpgMeta._deletedStrongholds || [];
        const snapshot = {
            bars: {}, status: {}, skills: {}, attributes: {}, reputation: {}, equipment: {},
            levels: {}, xp: {}, currency: {},
            strongholds: JSON.parse(JSON.stringify(userStrongholds)),
        };

        // 用户手动编辑的数据
        const userSkills = {};
        for (const [owner, arr] of Object.entries(rpgMeta.skills || {})) {
            const ua = (arr || []).filter(s => s._userAdded);
            if (ua.length) userSkills[owner] = ua;
        }
        const deletedSkills = rpgMeta._deletedSkills || [];
        const userAttrs = {};
        for (const [owner, vals] of Object.entries(rpgMeta.attributes || {})) {
            userAttrs[owner] = { ...vals };
        }

        // 装备格位配置（优先从 _rpgConfigs 读取）
        const _eqCfg = _cfgs.equipmentConfig || rpgMeta.equipmentConfig || { locked: false, perChar: {} };
        const _eqPerChar = _eqCfg.perChar || {};

        // 从消息中累积属性（snapshot 是独立对象，不污染 chat[0]）
        const _resolve = (raw) => this._resolveRpgOwner(raw);
        for (let i = 0; i < end; i++) {
            const changes = chat[i]?.horae_meta?._rpgChanges;
            if (!changes) continue;
            for (const [raw, barData] of Object.entries(changes.bars || {})) {
                const owner = _resolve(raw);
                if (!snapshot.bars[owner]) snapshot.bars[owner] = {};
                Object.assign(snapshot.bars[owner], barData);
            }
            for (const [raw, effects] of Object.entries(changes.status || {})) {
                const owner = _resolve(raw);
                snapshot.status[owner] = effects;
            }
            for (const sk of (changes.skills || [])) {
                const owner = _resolve(sk.owner);
                if (!snapshot.skills[owner]) snapshot.skills[owner] = [];
                const idx = snapshot.skills[owner].findIndex(s => s.name === sk.name);
                if (idx >= 0) {
                    if (sk.level != null) snapshot.skills[owner][idx].level = sk.level;
                    if (sk.desc != null) snapshot.skills[owner][idx].desc = sk.desc;
                } else {
                    snapshot.skills[owner].push({ name: sk.name, level: sk.level, desc: sk.desc });
                }
            }
            for (const sk of (changes.removedSkills || [])) {
                const owner = _resolve(sk.owner);
                if (snapshot.skills[owner]) {
                    snapshot.skills[owner] = snapshot.skills[owner].filter(s => s.name !== sk.name);
                }
            }
            for (const [raw, vals] of Object.entries(changes.attributes || {})) {
                const owner = _resolve(raw);
                snapshot.attributes[owner] = { ...(snapshot.attributes[owner] || {}), ...vals };
            }
            for (const [raw, cats] of Object.entries(changes.reputation || {})) {
                const owner = _resolve(raw);
                if (!snapshot.reputation[owner]) snapshot.reputation[owner] = {};
                for (const [catName, val] of Object.entries(cats)) {
                    if (!snapshot.reputation[owner][catName]) {
                        snapshot.reputation[owner][catName] = { value: val, subItems: {} };
                    } else {
                        snapshot.reputation[owner][catName].value = val;
                    }
                }
            }
            // 装备
            for (const u of (changes.unequip || [])) {
                const owner = _resolve(u.owner);
                if (!snapshot.equipment[owner]?.[u.slot]) continue;
                snapshot.equipment[owner][u.slot] = snapshot.equipment[owner][u.slot].filter(e => e.name !== u.name);
                if (!snapshot.equipment[owner][u.slot].length) delete snapshot.equipment[owner][u.slot];
                if (!Object.keys(snapshot.equipment[owner] || {}).length) delete snapshot.equipment[owner];
            }
            for (const eq of (changes.equipment || [])) {
                const owner = _resolve(eq.owner);
                const ownerCfg = _eqPerChar[owner];
                const maxCount = (ownerCfg && Array.isArray(ownerCfg.slots))
                    ? (ownerCfg.slots.find(s => s.name === eq.slot)?.maxCount ?? 1) : 1;
                if (!snapshot.equipment[owner]) snapshot.equipment[owner] = {};
                if (!snapshot.equipment[owner][eq.slot]) snapshot.equipment[owner][eq.slot] = [];
                const idx = snapshot.equipment[owner][eq.slot].findIndex(e => e.name === eq.name);
                if (idx >= 0) {
                    snapshot.equipment[owner][eq.slot][idx].attrs = eq.attrs;
                } else {
                    while (snapshot.equipment[owner][eq.slot].length >= maxCount) snapshot.equipment[owner][eq.slot].shift();
                    snapshot.equipment[owner][eq.slot].push({ name: eq.name, attrs: eq.attrs || {} });
                }
            }
            // 等级/经验
            for (const [raw, val] of Object.entries(changes.levels || {})) {
                snapshot.levels[_resolve(raw)] = val;
            }
            for (const [raw, val] of Object.entries(changes.xp || {})) {
                snapshot.xp[_resolve(raw)] = val;
            }
            // 货币（优先从 _rpgConfigs 读取配置）
            const validDenoms = new Set(
                ((_cfgs.currencyConfig || rpgMeta.currencyConfig)?.denominations || []).map(d => d.name)
            );
            for (const c of (changes.currency || [])) {
                if (validDenoms.size && !validDenoms.has(c.name)) continue;
                const owner = _resolve(c.owner);
                if (!snapshot.currency[owner]) snapshot.currency[owner] = {};
                if (c.isDelta) {
                    snapshot.currency[owner][c.name] = (snapshot.currency[owner][c.name] || 0) + c.value;
                } else {
                    snapshot.currency[owner][c.name] = c.value;
                }
            }
            // 据点累积（与 _mergeRpgData 同逻辑，跳过已删除节点）
            if (changes.baseChanges?.length > 0) {
                for (const bc of changes.baseChanges) {
                    const pathParts = bc.path.split('>').map(s => s.trim()).filter(Boolean);
                    let parentId = null;
                    let targetNode = null;
                    let blocked = false;
                    for (const part of pathParts) {
                        const parentName = parentId ? (snapshot.strongholds.find(n => n.id === parentId)?.name || null) : null;
                        if (deletedSh.some(d => d.name === part && (d.parent || null) === parentName)) { blocked = true; break; }
                        targetNode = snapshot.strongholds.find(n => n.name === part && (n.parent || null) === parentId);
                        if (!targetNode) {
                            targetNode = { id: 'sh_' + i + '_' + Math.random().toString(36).slice(2, 6), name: part, level: null, desc: '', parent: parentId };
                            snapshot.strongholds.push(targetNode);
                        }
                        parentId = targetNode.id;
                    }
                    if (blocked || !targetNode) continue;
                    if (bc.field === 'level') targetNode.level = typeof bc.value === 'number' ? bc.value : parseInt(bc.value);
                    else if (bc.field === 'desc') targetNode.desc = String(bc.value);
                }
            }
        }

        // 合入用户手动属性（AI数据优先覆盖）
        for (const [owner, vals] of Object.entries(userAttrs)) {
            if (!snapshot.attributes[owner]) snapshot.attributes[owner] = {};
            for (const [k, v] of Object.entries(vals)) {
                if (snapshot.attributes[owner][k] === undefined) snapshot.attributes[owner][k] = v;
            }
        }
        // 回填用户手动技能
        for (const [owner, arr] of Object.entries(userSkills)) {
            if (!snapshot.skills[owner]) snapshot.skills[owner] = [];
            for (const sk of arr) {
                if (!snapshot.skills[owner].some(s => s.name === sk.name)) snapshot.skills[owner].push(sk);
            }
        }
        // 过滤用户手动删除
        for (const del of deletedSkills) {
            if (snapshot.skills[del.owner]) {
                snapshot.skills[del.owner] = snapshot.skills[del.owner].filter(s => s.name !== del.name);
                if (!snapshot.skills[del.owner].length) delete snapshot.skills[del.owner];
            }
        }
        // 声望：合入用户细项，_userEdited 的主数值优先于 AI 回放结果
        const repConfig = rpgMeta.reputationConfig || { categories: [], _deletedCategories: [] };
        const validRepNames = new Set((repConfig.categories || []).map(c => c.name));
        const deletedRepNames = new Set(repConfig._deletedCategories || []);
        const userRep = rpgMeta.reputation || {};
        for (const [owner, cats] of Object.entries(userRep)) {
            if (!snapshot.reputation[owner]) snapshot.reputation[owner] = {};
            for (const [catName, data] of Object.entries(cats)) {
                if (deletedRepNames.has(catName) || !validRepNames.has(catName)) continue;
                if (!snapshot.reputation[owner][catName]) {
                    snapshot.reputation[owner][catName] = { ...data };
                } else {
                    snapshot.reputation[owner][catName].subItems = data.subItems || {};
                    if (data._userEdited) {
                        snapshot.reputation[owner][catName].value = data.value;
                        snapshot.reputation[owner][catName]._userEdited = true;
                    }
                }
            }
        }
        // 移除快照中已删除的声望分类
        for (const [owner, cats] of Object.entries(snapshot.reputation)) {
            for (const catName of Object.keys(cats)) {
                if (deletedRepNames.has(catName) || !validRepNames.has(catName)) {
                    delete cats[catName];
                }
            }
            if (!Object.keys(cats).length) delete snapshot.reputation[owner];
        }
        snapshot.reputationConfig = repConfig;
        // 装备：按角色过滤已删除格位
        for (const [owner, slots] of Object.entries(snapshot.equipment)) {
            const ownerCfg = _eqPerChar[owner];
            if (!ownerCfg || !Array.isArray(ownerCfg.slots)) continue;
            const validEqSlots = new Set(ownerCfg.slots.map(s => s.name));
            const deletedEqSlots = new Set(ownerCfg._deletedSlots || []);
            for (const slotName of Object.keys(slots)) {
                if (deletedEqSlots.has(slotName) || (validEqSlots.size > 0 && !validEqSlots.has(slotName))) {
                    delete slots[slotName];
                }
            }
            if (!Object.keys(slots).length) delete snapshot.equipment[owner];
        }
        snapshot.equipmentConfig = _eqCfg;
        // 货币配置
        snapshot.currencyConfig = rpgMeta.currencyConfig || { denominations: [] };
        return snapshot;
    }

    /** 合并关系数据到 chat[0].horae_meta */
    _mergeRelationships(newRels) {
        const chat = this.getChat();
        if (!chat?.length || !newRels?.length) return;
        const firstMsg = chat[0];
        if (!firstMsg.horae_meta) firstMsg.horae_meta = createEmptyMeta();
        if (!firstMsg.horae_meta.relationships) firstMsg.horae_meta.relationships = [];
        const existing = firstMsg.horae_meta.relationships;
        for (const rel of newRels) {
            const idx = existing.findIndex(r => r.from === rel.from && r.to === rel.to);
            if (idx >= 0) {
                if (existing[idx]._userEdited) continue;
                existing[idx].type = rel.type;
                if (rel.note) existing[idx].note = rel.note;
            } else {
                existing.push({ ...rel });
            }
        }
    }

    /** 从所有消息重建 chat[0] 的关系网络（用于编辑/删除后回推） */
    rebuildRelationships() {
        const chat = this.getChat();
        if (!chat?.length) return;
        const firstMsg = chat[0];
        if (!firstMsg.horae_meta) firstMsg.horae_meta = createEmptyMeta();
        // 保留用户手动编辑的关系，其余重建
        const userEdited = (firstMsg.horae_meta.relationships || []).filter(r => r._userEdited);
        firstMsg.horae_meta.relationships = [...userEdited];
        for (let i = 1; i < chat.length; i++) {
            const rels = chat[i]?.horae_meta?.relationships;
            if (rels?.length) this._mergeRelationships(rels);
        }
    }

    /** 从所有消息重建 chat[0] 的场景记忆（用于编辑/删除/重新生成后回推） */
    rebuildLocationMemory() {
        const chat = this.getChat();
        if (!chat?.length) return;
        const firstMsg = chat[0];
        if (!firstMsg.horae_meta) firstMsg.horae_meta = createEmptyMeta();
        const existing = firstMsg.horae_meta.locationMemory || {};
        const rebuilt = {};
        const deletedNames = new Set();
        // 保留用户手动创建/编辑的条目，记录已删除的条目
        for (const [name, info] of Object.entries(existing)) {
            if (info._deleted) {
                deletedNames.add(name);
                rebuilt[name] = { ...info };
                continue;
            }
            if (info._userEdited) rebuilt[name] = { ...info };
        }
        // 从消息重放 AI 写入的 scene_desc（按时间顺序，后覆盖前），跳过已删除/用户编辑的
        for (let i = 1; i < chat.length; i++) {
            const meta = chat[i]?.horae_meta;
            const pairs = meta?.scene?._descPairs;
            if (pairs?.length > 0) {
                for (const p of pairs) {
                    if (deletedNames.has(p.location)) continue;
                    if (rebuilt[p.location]?._userEdited) continue;
                    rebuilt[p.location] = {
                        desc: p.desc,
                        firstSeen: rebuilt[p.location]?.firstSeen || new Date().toISOString(),
                        lastUpdated: new Date().toISOString()
                    };
                }
            } else if (meta?.scene?.scene_desc && meta?.scene?.location) {
                const loc = meta.scene.location;
                if (deletedNames.has(loc)) continue;
                if (rebuilt[loc]?._userEdited) continue;
                rebuilt[loc] = {
                    desc: meta.scene.scene_desc,
                    firstSeen: rebuilt[loc]?.firstSeen || new Date().toISOString(),
                    lastUpdated: new Date().toISOString()
                };
            }
        }
        firstMsg.horae_meta.locationMemory = rebuilt;
    }

    getRelationships() {
        const chat = this.getChat();
        return chat?.[0]?.horae_meta?.relationships || [];
    }

    /** 设置关系网络（用户手动编辑时） */
    setRelationships(relationships) {
        const chat = this.getChat();
        if (!chat?.length) return;
        const firstMsg = chat[0];
        if (!firstMsg.horae_meta) firstMsg.horae_meta = createEmptyMeta();
        firstMsg.horae_meta.relationships = relationships;
    }

    /** 获取指定角色相关的关系（无在场角色时返回空数组） */
    getRelationshipsForCharacters(charNames) {
        if (!charNames?.length) return [];
        const rels = this.getRelationships();
        const nameSet = new Set(charNames);
        return rels.filter(r => nameSet.has(r.from) || nameSet.has(r.to));
    }

    /** 全局删除已完成的待办事项 */
    removeCompletedAgenda(deletedTexts) {
        const chat = this.getChat();
        if (!chat || deletedTexts.length === 0) return;

        const isMatch = (agendaText, deleteText) => {
            if (!agendaText || !deleteText) return false;
            // 精确匹配 或 互相包含（允许AI缩写/扩写）
            return agendaText === deleteText ||
                   agendaText.includes(deleteText) ||
                   deleteText.includes(agendaText);
        };

        if (chat[0]?.horae_meta?.agenda) {
            chat[0].horae_meta.agenda = chat[0].horae_meta.agenda.filter(
                a => !deletedTexts.some(dt => isMatch(a.text, dt))
            );
        }

        for (let i = 1; i < chat.length; i++) {
            if (chat[i]?.horae_meta?.agenda?.length > 0) {
                chat[i].horae_meta.agenda = chat[i].horae_meta.agenda.filter(
                    a => !deletedTexts.some(dt => isMatch(a.text, dt))
                );
            }
        }
    }

    /** 写入/更新场景记忆到 chat[0] */
    _updateLocationMemory(locationName, desc) {
        const chat = this.getChat();
        if (!chat?.length || !locationName || !desc) return;
        const firstMsg = chat[0];
        if (!firstMsg.horae_meta) firstMsg.horae_meta = createEmptyMeta();
        if (!firstMsg.horae_meta.locationMemory) firstMsg.horae_meta.locationMemory = {};
        const mem = firstMsg.horae_meta.locationMemory;
        const now = new Date().toISOString();

        // 子级地点去重：若子级描述的"位于"部分重复了父级的地理信息，则自动缩减
        const sepMatch = locationName.match(/[·・\-\/\|]/);
        if (sepMatch) {
            const parentName = locationName.substring(0, sepMatch.index).trim();
            const parentEntry = mem[parentName];
            if (parentEntry?.desc) {
                desc = this._deduplicateChildDesc(desc, parentEntry.desc, parentName);
            }
        }

        if (mem[locationName]) {
            if (mem[locationName]._userEdited || mem[locationName]._deleted) return;
            mem[locationName].desc = desc;
            mem[locationName].lastUpdated = now;
        } else {
            mem[locationName] = { desc, firstSeen: now, lastUpdated: now };
        }
        console.log(`[Horae] 场景记忆已更新: ${locationName}`);
    }

    /**
     * 子级描述去重：检测子级描述是否包含父级的地理位置信息，若包含则替换为相对位置
     */
    _deduplicateChildDesc(childDesc, parentDesc, parentName) {
        if (!childDesc || !parentDesc) return childDesc;
        // 提取父级的"位于"部分
        const parentLocMatch = parentDesc.match(/^位于(.+?)[。\.]/);
        if (!parentLocMatch) return childDesc;
        const parentLocInfo = parentLocMatch[1].trim();
        // 若子级描述也包含父级的地理位置关键词（超过一半的字重合），则认为冗余
        const parentKeywords = parentLocInfo.replace(/[，,、的]/g, ' ').split(/\s+/).filter(k => k.length >= 2);
        if (parentKeywords.length === 0) return childDesc;
        const childLocMatch = childDesc.match(/^位于(.+?)[。\.]/);
        if (!childLocMatch) return childDesc;
        const childLocInfo = childLocMatch[1].trim();
        let matchCount = 0;
        for (const kw of parentKeywords) {
            if (childLocInfo.includes(kw)) matchCount++;
        }
        // 超过一半关键词重合，判定子级抄了父级地理位置
        if (matchCount >= Math.ceil(parentKeywords.length / 2)) {
            const shortName = parentName.length > 4 ? parentName.substring(0, 4) + '…' : parentName;
            const restDesc = childDesc.substring(childLocMatch[0].length).trim();
            return `位于${shortName}内。${restDesc}`;
        }
        return childDesc;
    }

    /** 获取场景记忆 */
    getLocationMemory() {
        const chat = this.getChat();
        return chat?.[0]?.horae_meta?.locationMemory || {};
    }

    /**
     * 智能匹配场景记忆（复合地名支持）
     * 优先级：精确匹配 → 拆分回退父级 → 上下文推断 → 放弃
     */
    _findLocationMemory(currentLocation, locMem, previousLocation = '') {
        if (!currentLocation || !locMem || Object.keys(locMem).length === 0) return null;

        const tag = (name) => ({ ...locMem[name], _matchedName: name });

        if (locMem[currentLocation]) return tag(currentLocation);

        // 曾用名匹配：检查所有条目的 _aliases 数组
        for (const [name, info] of Object.entries(locMem)) {
            if (info._aliases?.includes(currentLocation)) return tag(name);
        }

        const SEP = /[·・\-\/|]/;
        const parts = currentLocation.split(SEP).map(s => s.trim()).filter(Boolean);

        if (parts.length > 1) {
            for (let i = parts.length - 1; i >= 1; i--) {
                const partial = parts.slice(0, i).join('·');
                if (locMem[partial]) return tag(partial);
                for (const [name, info] of Object.entries(locMem)) {
                    if (info._aliases?.includes(partial)) return tag(name);
                }
            }
        }

        if (previousLocation) {
            const prevParts = previousLocation.split(SEP).map(s => s.trim()).filter(Boolean);
            const prevParent = prevParts[0] || previousLocation;
            const curParent = parts[0] || currentLocation;

            if (prevParent !== curParent && prevParent.includes(curParent)) {
                if (locMem[prevParent]) return tag(prevParent);
            }
        }

        return null;
    }

    /**
     * 获取全局表格的当前卡片数据（per-card overlay）
     * 全局表格的结构（表头、名称、提示词、锁定）共享，数据按角色卡分离
     */
    _getResolvedGlobalTables() {
        const templates = this.settings?.globalTables || [];
        const chat = this.getChat();
        if (!chat?.[0] || templates.length === 0) return [];

        const firstMsg = chat[0];
        if (!firstMsg.horae_meta) firstMsg.horae_meta = createEmptyMeta();
        if (!firstMsg.horae_meta.globalTableData) firstMsg.horae_meta.globalTableData = {};
        const perCardData = firstMsg.horae_meta.globalTableData;

        const result = [];
        for (const template of templates) {
            const name = (template.name || '').trim();
            if (!name) continue;

            if (!perCardData[name]) {
                // 首次在此卡使用：从模板初始化（含迁移旧数据）
                const initData = JSON.parse(JSON.stringify(template.data || {}));
                perCardData[name] = {
                    data: initData,
                    rows: template.rows || 2,
                    cols: template.cols || 2,
                    baseData: JSON.parse(JSON.stringify(initData)),
                    baseRows: template.rows || 2,
                    baseCols: template.cols || 2,
                };
            } else {
                // 同步全局模板的表头到 per-card（用户可能在别处改了表头）
                const templateData = template.data || {};
                for (const key of Object.keys(templateData)) {
                    const [r, c] = key.split('-').map(Number);
                    if (r === 0 || c === 0) {
                        perCardData[name].data[key] = templateData[key];
                    }
                }
            }

            const overlay = perCardData[name];
            result.push({
                name: template.name,
                prompt: template.prompt,
                lockedRows: template.lockedRows || [],
                lockedCols: template.lockedCols || [],
                lockedCells: template.lockedCells || [],
                data: overlay.data,
                rows: overlay.rows,
                cols: overlay.cols,
                baseData: overlay.baseData,
                baseRows: overlay.baseRows,
                baseCols: overlay.baseCols,
            });
        }
        return result;
    }

    /**
     * 获取角色表格的当前对话数据（per-chat overlay）
     * 角色表格的结构（表头、名称、提示词、锁定）绑定角色卡，数据按对话分离
     */
    _getResolvedCharacterTables() {
        const charId = this.context?.characterId;
        if (charId == null) return [];
        const charData = this.context?.characters?.[charId]?.data;
        if (!charData?.extensions?.horae?.charTables) return [];

        const templates = charData.extensions.horae.charTables;
        const chat = this.getChat();
        if (!chat?.[0] || templates.length === 0) return [];

        const firstMsg = chat[0];
        if (!firstMsg.horae_meta) firstMsg.horae_meta = createEmptyMeta();
        if (!firstMsg.horae_meta.charTableData) firstMsg.horae_meta.charTableData = {};
        const perChatData = firstMsg.horae_meta.charTableData;

        const result = [];
        for (const template of templates) {
            const name = (template.name || '').trim();
            if (!name) continue;

            if (!perChatData[name]) {
                const initData = JSON.parse(JSON.stringify(template.data || {}));
                perChatData[name] = {
                    data: initData,
                    rows: template.rows || 2,
                    cols: template.cols || 2,
                    baseData: JSON.parse(JSON.stringify(initData)),
                    baseRows: template.rows || 2,
                    baseCols: template.cols || 2,
                };
            } else {
                const templateData = template.data || {};
                for (const key of Object.keys(templateData)) {
                    const [r, c] = key.split('-').map(Number);
                    if (r === 0 || c === 0) {
                        perChatData[name].data[key] = templateData[key];
                    }
                }
            }

            const overlay = perChatData[name];
            result.push({
                name: template.name,
                prompt: template.prompt,
                lockedRows: template.lockedRows || [],
                lockedCols: template.lockedCols || [],
                lockedCells: template.lockedCells || [],
                data: overlay.data,
                rows: overlay.rows,
                cols: overlay.cols,
                baseData: overlay.baseData,
                baseRows: overlay.baseRows,
                baseCols: overlay.baseCols,
            });
        }
        return result;
    }

    /** 处理AI回复，解析标签并存储元数据 */
    processAIResponse(messageIndex, messageContent) {
        // 根据用户配置的剔除标签，整块移除小剧场等自定义区块，防止其内部的 horae 标签污染正文解析
        const cleanedContent = this._stripCustomTags(messageContent, this.settings?.vectorStripTags);
        let parsed = this.parseHoraeTag(cleanedContent);
        
        // 标签解析失败时，自动 fallback 到宽松格式解析
        if (!parsed) {
            parsed = this.parseLooseFormat(cleanedContent);
            if (parsed) {
                console.log(`[Horae] #${messageIndex} 未检测到标签，已通过宽松解析提取数据`);
            }
        }
        
        if (parsed) {
            const existingMeta = this.getMessageMeta(messageIndex);
            const newMeta = this.mergeParsedToMeta(existingMeta, parsed);
            
            // 处理表格更新
            if (newMeta._tableUpdates) {
                // 记录表格贡献，用于回退
                newMeta.tableContributions = newMeta._tableUpdates;
                this.applyTableUpdates(newMeta._tableUpdates);
                delete newMeta._tableUpdates;
            }
            
            // 处理AI标记已完成的待办
            if (parsed.deletedAgenda && parsed.deletedAgenda.length > 0) {
                this.removeCompletedAgenda(parsed.deletedAgenda);
            }

            // 场景记忆：将 scene_desc 存入 locationMemory（支持同一回复多场景配对）
            const descPairs = parsed.scene?._descPairs;
            if (descPairs?.length > 0) {
                for (const p of descPairs) {
                    this._updateLocationMemory(p.location, p.desc);
                }
            } else if (parsed.scene?.scene_desc && parsed.scene?.location) {
                this._updateLocationMemory(parsed.scene.location, parsed.scene.scene_desc);
            }
            
            // 关系网络：合并到 chat[0].horae_meta.relationships
            if (parsed.relationships && parsed.relationships.length > 0) {
                this._mergeRelationships(parsed.relationships);
            }
            
            this.setMessageMeta(messageIndex, newMeta);
            
            // RPG 数据：合并到 chat[0].horae_meta.rpg
            if (newMeta._rpgChanges) {
                this._mergeRpgData(newMeta._rpgChanges);
            }
            return true;
        } else {
            // 无标签，创建空元数据
            if (!this.getMessageMeta(messageIndex)) {
                this.setMessageMeta(messageIndex, createEmptyMeta());
            }
            return false;
        }
    }

    /**
     * 解析NPC字段
     * 格式: 名|外貌=性格@关系~性别:男~年龄:25~种族:人类~职业:佣兵~补充:xxx
     */
    _parseNpcFields(npcStr) {
        const info = {};
        if (!npcStr) return { _name: '' };
        
        // 1. 分离扩展字段
        const tildeParts = npcStr.split('~');
        const mainPart = tildeParts[0].trim(); // 名|外貌=性格@关系
        
        for (let i = 1; i < tildeParts.length; i++) {
            const kv = tildeParts[i].trim();
            if (!kv) continue;
            const colonIdx = kv.indexOf(':');
            if (colonIdx <= 0) continue;
            const key = kv.substring(0, colonIdx).trim();
            const value = kv.substring(colonIdx + 1).trim();
            if (!value) continue;
            
            // 关键词匹配
            if (/^(性别|gender|sex)$/i.test(key)) info.gender = value;
            else if (/^(年龄|age|年纪)$/i.test(key)) info.age = value;
            else if (/^(种族|race|族裔|族群)$/i.test(key)) info.race = value;
            else if (/^(职业|job|class|职务|身份)$/i.test(key)) info.job = value;
            else if (/^(生日|birthday|birth)$/i.test(key)) info.birthday = value;
            else if (/^(补充|note|备注|其他)$/i.test(key)) info.note = value;
        }
        
        // 2. 解析主体
        let name = '';
        const pipeIdx = mainPart.indexOf('|');
        if (pipeIdx > 0) {
            name = mainPart.substring(0, pipeIdx).trim();
            const descPart = mainPart.substring(pipeIdx + 1).trim();
            
            const hasNewFormat = descPart.includes('=') || descPart.includes('@');
            
            if (hasNewFormat) {
                const atIdx = descPart.indexOf('@');
                let beforeAt = atIdx >= 0 ? descPart.substring(0, atIdx) : descPart;
                const relationship = atIdx >= 0 ? descPart.substring(atIdx + 1).trim() : '';
                
                const eqIdx = beforeAt.indexOf('=');
                const appearance = eqIdx >= 0 ? beforeAt.substring(0, eqIdx).trim() : beforeAt.trim();
                const personality = eqIdx >= 0 ? beforeAt.substring(eqIdx + 1).trim() : '';
                
                if (appearance) info.appearance = appearance;
                if (personality) info.personality = personality;
                if (relationship) info.relationship = relationship;
            } else {
                const parts = descPart.split('|').map(s => s.trim());
                if (parts[0]) info.appearance = parts[0];
                if (parts[1]) info.personality = parts[1];
                if (parts[2]) info.relationship = parts[2];
            }
        } else {
            name = mainPart.trim();
        }
        
        info._name = name;
        return info;
    }

    /**
     * 解析表格单元格数据
     * 格式: 每行一格 1,1:内容 或 单行多格用 | 分隔
     */
    _parseTableCellEntries(text) {
        const updates = {};
        if (!text) return updates;
        
        const cellRegex = /^(\d+)[,\-](\d+)[:：]\s*(.*)$/;
        
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            // 按 | 分割
            const segments = trimmed.split(/\s*[|｜]\s*/);
            
            for (const seg of segments) {
                const s = seg.trim();
                if (!s) continue;
                
                const m = s.match(cellRegex);
                if (m) {
                    const r = parseInt(m[1]);
                    const c = parseInt(m[2]);
                    const value = m[3].trim();
                    // 过滤空标记
                    if (value && !/^[\(\（]?空[\)\）]?$/.test(value) && !/^[-—]+$/.test(value)) {
                        updates[`${r}-${c}`] = value;
                    }
                }
            }
        }
        
        return updates;
    }

    /** 将表格更新写入 chat[0]（本地表格）、角色表格 overlay 或全局表格 overlay */
    applyTableUpdates(tableUpdates) {
        if (!tableUpdates || tableUpdates.length === 0) return;

        const chat = this.getChat();
        if (!chat || chat.length === 0) return;

        const firstMsg = chat[0];
        if (!firstMsg.horae_meta) firstMsg.horae_meta = createEmptyMeta();
        if (!firstMsg.horae_meta.customTables) firstMsg.horae_meta.customTables = [];

        const localTables = firstMsg.horae_meta.customTables;
        const resolvedCharacter = this._getResolvedCharacterTables();
        const resolvedGlobal = this._getResolvedGlobalTables();

        for (const update of tableUpdates) {
            const updateName = (update.name || '').trim();
            let table = localTables.find(t => (t.name || '').trim() === updateName);
            let isGlobal = false;
            let isCharacter = false;
            if (!table) {
                table = resolvedCharacter.find(t => (t.name || '').trim() === updateName);
                isCharacter = !!table;
            }
            if (!table) {
                table = resolvedGlobal.find(t => (t.name || '').trim() === updateName);
                isGlobal = true;
            }
            if (!table) {
                console.warn(`[Horae] 表格 "${updateName}" 不存在，跳过`);
                continue;
            }

            if (!table.data) table.data = {};
            const lockedRows = new Set(table.lockedRows || []);
            const lockedCols = new Set(table.lockedCols || []);
            const lockedCells = new Set(table.lockedCells || []);

            // 用户编辑快照：先清除所有数据单元格再整体写入
            if (update._isUserEdit) {
                for (const key of Object.keys(table.data)) {
                    const [r, c] = key.split('-').map(Number);
                    if (r >= 1 && c >= 1) delete table.data[key];
                }
            }

            let updatedCount = 0;
            let blockedCount = 0;

            for (const [key, value] of Object.entries(update.updates)) {
                const [r, c] = key.split('-').map(Number);

                // 用户编辑不受 header 保护和锁定限制
                if (!update._isUserEdit) {
                    if (r === 0 || c === 0) {
                        const existing = table.data[key];
                        if (existing && existing.trim()) continue;
                    }

                    if (lockedRows.has(r) || lockedCols.has(c) || lockedCells.has(key)) {
                        blockedCount++;
                        continue;
                    }
                }

                table.data[key] = value;
                updatedCount++;

                if (r + 1 > (table.rows || 2)) table.rows = r + 1;
                if (c + 1 > (table.cols || 2)) table.cols = c + 1;
            }

            // 全局/角色表格：将维度变更同步回 overlay
            if (isGlobal) {
                const perCardData = firstMsg.horae_meta?.globalTableData;
                if (perCardData?.[updateName]) {
                    perCardData[updateName].rows = table.rows;
                    perCardData[updateName].cols = table.cols;
                }
            }
            if (isCharacter) {
                const perChatData = firstMsg.horae_meta?.charTableData;
                if (perChatData?.[updateName]) {
                    perChatData[updateName].rows = table.rows;
                    perChatData[updateName].cols = table.cols;
                }
            }

            if (blockedCount > 0) {
                console.log(`[Horae] 表格 "${updateName}" 拦截 ${blockedCount} 个锁定单元格的修改`);
            }
            console.log(`[Horae] 表格 "${updateName}" 已更新 ${updatedCount} 个单元格`);
        }
    }

    /** 重建表格数据（消息删除/编辑后保持一致性） */
    rebuildTableData(maxIndex = -1) {
        const chat = this.getChat();
        if (!chat || chat.length === 0) return;
        
        const firstMsg = chat[0];
        const limit = maxIndex >= 0 ? Math.min(maxIndex + 1, chat.length) : chat.length;

        // 辅助：重置单个表格到 baseData
        const resetTable = (table) => {
            if (table.baseData) {
                table.data = JSON.parse(JSON.stringify(table.baseData));
            } else {
                if (!table.data) { table.data = {}; return; }
                const keysToDelete = [];
                for (const key of Object.keys(table.data)) {
                    const [r, c] = key.split('-').map(Number);
                    if (r >= 1 && c >= 1) keysToDelete.push(key);
                }
                for (const key of keysToDelete) delete table.data[key];
            }
            if (table.baseRows !== undefined) {
                table.rows = table.baseRows;
            } else if (table.baseData) {
                let calcRows = 2, calcCols = 2;
                for (const key of Object.keys(table.baseData)) {
                    const [r, c] = key.split('-').map(Number);
                    if (r === 0 && c + 1 > calcCols) calcCols = c + 1;
                    if (c === 0 && r + 1 > calcRows) calcRows = r + 1;
                }
                table.rows = calcRows;
                table.cols = calcCols;
            }
            if (table.baseCols !== undefined) {
                table.cols = table.baseCols;
            }
        };

        // 1a. 重置本地表格
        const localTables = firstMsg.horae_meta?.customTables || [];
        for (const table of localTables) {
            resetTable(table);
        }

        // 1b. 重置全局表格的 per-card overlay
        const perCardData = firstMsg.horae_meta?.globalTableData || {};
        for (const overlay of Object.values(perCardData)) {
            resetTable(overlay);
        }

        // 1c. 重置角色表格的 per-chat overlay
        const charTableOverlays = firstMsg.horae_meta?.charTableData || {};
        for (const overlay of Object.values(charTableOverlays)) {
            resetTable(overlay);
        }
        
        // 2. 预扫描：找到每个表格最后一个 _isUserEdit 所在的消息索引
        const lastUserEditIdx = new Map();
        for (let i = 0; i < limit; i++) {
            const meta = chat[i]?.horae_meta;
            if (meta?.tableContributions) {
                for (const tc of meta.tableContributions) {
                    if (tc._isUserEdit) {
                        lastUserEditIdx.set((tc.name || '').trim(), i);
                    }
                }
            }
        }

        // 3. 按消息顺序回放 tableContributions（截断到 limit）
        // 防御：如果某表格存在用户编辑快照，跳过该快照之前的所有 AI 贡献
        let totalApplied = 0;
        for (let i = 0; i < limit; i++) {
            const meta = chat[i]?.horae_meta;
            if (meta?.tableContributions && meta.tableContributions.length > 0) {
                const filtered = meta.tableContributions.filter(tc => {
                    if (tc._isUserEdit) return true;
                    const name = (tc.name || '').trim();
                    const ueIdx = lastUserEditIdx.get(name);
                    if (ueIdx !== undefined && i <= ueIdx) return false;
                    return true;
                });
                if (filtered.length > 0) {
                    this.applyTableUpdates(filtered);
                    totalApplied++;
                }
            }
        }
        
        console.log(`[Horae] 表格数据已重建，回放了 ${totalApplied} 条消息的表格贡献（截止到#${limit - 1}）`);
    }

    /** 扫描并注入历史记录 */
    async scanAndInjectHistory(progressCallback, analyzeCallback = null) {
        const chat = this.getChat();
        let processed = 0;
        let skipped = 0;

        const PRESERVE_KEYS = [
            'autoSummaries', 'customTables', 'globalTableData', 'charTableData',
            'locationMemory', 'relationships', 'tableContributions',
            'rpg', '_rpgChanges',
            '_deletedNpcs', '_deletedAgendaTexts',
            '_rpgConfigs', '_pendingScanReview', '_userAddedNpcs'
        ];

        for (let i = 0; i < chat.length; i++) {
            const message = chat[i];

            if (message.is_user) {
                skipped++;
                if (progressCallback) {
                    progressCallback(Math.round((i + 1) / chat.length * 100), i + 1, chat.length);
                }
                continue;
            }

            const existing = message.horae_meta;
            const preserved = {};
            const oldEvents = [];
            const wasSkipped = !!existing?._skipHorae;

            if (existing) {
                for (const key of PRESERVE_KEYS) {
                    if (existing[key] !== undefined) preserved[key] = existing[key];
                }
                if (existing.events?.length > 0) {
                    for (const evt of existing.events) {
                        if (evt._compressedBy || evt._summaryId || evt.isSummary) {
                            oldEvents.push(evt);
                        }
                    }
                }
            }

            const _applyPreserved = (meta) => {
                Object.assign(meta, preserved);
                if (wasSkipped) meta._skipHorae = true;
                if (oldEvents.length > 0) {
                    if (!meta.events) meta.events = [];
                    const nonSummaryFlags = oldEvents.filter(e => !e.isSummary);
                    const summaryEvts = oldEvents.filter(e => e.isSummary);
                    for (const flag of nonSummaryFlags) {
                        if (!flag._compressedBy) continue;
                        const match = meta.events.find(e =>
                            !e.isSummary && !e._compressedBy &&
                            e.summary && flag.summary &&
                            e.summary === flag.summary
                        );
                        if (match) match._compressedBy = flag._compressedBy;
                    }
                    for (const sEvt of summaryEvts) {
                        if (!sEvt._summaryId) continue;
                        const exists = meta.events.some(e => e._summaryId === sEvt._summaryId);
                        if (!exists) {
                            meta.events.push({
                                summary: sEvt.summary,
                                level: sEvt.level || '摘要',
                                isSummary: true,
                                _summaryId: sEvt._summaryId,
                            });
                        }
                    }
                }
            };

            const parsed = this.parseHoraeTag(message.mes);

            if (parsed) {
                const meta = this.mergeParsedToMeta(null, parsed);
                if (meta._tableUpdates) {
                    meta.tableContributions = meta._tableUpdates;
                    delete meta._tableUpdates;
                }
                _applyPreserved(meta);
                this.setMessageMeta(i, meta);
                processed++;
            } else if (analyzeCallback) {
                try {
                    const analyzed = await analyzeCallback(message.mes);
                    if (analyzed) {
                        const meta = this.mergeParsedToMeta(null, analyzed);
                        if (meta._tableUpdates) {
                            meta.tableContributions = meta._tableUpdates;
                            delete meta._tableUpdates;
                        }
                        _applyPreserved(meta);
                        this.setMessageMeta(i, meta);
                        processed++;
                    }
                } catch (error) {
                    console.error(`[Horae] 分析消息 #${i} 失败:`, error);
                }
            } else {
                const meta = createEmptyMeta();
                _applyPreserved(meta);
                this.setMessageMeta(i, meta);
                processed++;
            }

            if (progressCallback) {
                progressCallback(Math.round((i + 1) / chat.length * 100), i + 1, chat.length);
            }
        }

        return { processed, skipped };
    }

    generateSystemPromptAddition() {
        const lang = this._getAiOutputLang();
        const [userName, charName] = this._getDefaultNames();

        if (this.settings?.customSystemPrompt) {
            const custom = this.settings.customSystemPrompt
                .replace(/\{\{user\}\}/gi, userName)
                .replace(/\{\{char\}\}/gi, charName);
            return custom + this.generateLocationMemoryPrompt() + this.generateCustomTablesPrompt() + this.generateRelationshipPrompt() + this.generateMoodPrompt() + this.generateRpgPrompt();
        }

        let base = this.getDefaultSystemPrompt()
            .replace(/\{\{user\}\}/gi, userName)
            .replace(/\{\{char\}\}/gi, charName);

        const subs = this.generateLocationMemoryPrompt() + this.generateCustomTablesPrompt() +
                     this.generateRelationshipPrompt() + this.generateMoodPrompt() +
                     this.generateRpgPrompt() + this._generateAntiParaphrasePrompt();

        const markers = {
            'zh-CN': '\n═══ 最终强制提醒 ═══', 'zh-TW': '\n═══ 最終強制提醒 ═══',
            'ja': '\n═══ 最終必須リマインダー ═══', 'ko': '\n═══ 최종 필수 리마인더 ═══',
            'ru': '\n═══ Финальное обязательное напоминание ═══',
        };
        const marker = markers[lang] || '\n═══ Final Mandatory Reminder ═══';
        base = base.replace(marker, subs + marker);
        return '\n' + base;
    }

    getDefaultSystemPrompt() {
        const lang = this._getAiOutputLang();
        if (lang === 'ja') return this._getDefaultSystemPromptJa();
        if (lang === 'ko') return this._getDefaultSystemPromptKo();
        if (lang === 'ru') return this._getDefaultSystemPromptRu();
        if (lang !== 'zh-CN' && lang !== 'zh-TW') return this._getDefaultSystemPromptEn();
        const sceneDescLine = this.settings?.sendLocationMemory ? '\nscene_desc:地点固定物理特征（见场景记忆规则，触发时才写）' : '';
        const relLine = this.settings?.sendRelationships ? '\nrel:角色A>角色B=关系类型|备注（见关系网络规则，触发时才写）' : '';
        const moodLine = this.settings?.sendMood ? '\nmood:角色名=情绪/心理状态（见情绪追踪规则，触发时才写）' : '';
        return `【Horae记忆系统】（以下示例仅为示范，勿直接原句用于正文！）

═══ 核心原则：变化驱动 ═══
★★★ 在写<horae>标签前，先判断本回合哪些信息发生了实质变化 ★★★
  ① 场景基础（time/location/characters/costume）→ 每回合必填
  ② 其他所有字段 → 严格遵守各自的【触发条件】，无变化则完全不写该行
  ③ 已记录的NPC/物品若无新信息 → 禁止输出！重复输出无变化的数据=浪费token
  ④ 部分字段变化 → 使用增量更新，只写变化的部分
  ⑤ NPC首次出场 → npc:和affection:两行都必须写！

═══ 标签格式 ═══
每次回复末尾必须写入两个标签：
<horae>
time:日期 时间（必填）
location:地点（必填。多级地点用·分隔，如「酒馆·大厅」「皇宫·王座间」。同一地点每次必须使用完全一致的名称）
atmosphere:氛围${sceneDescLine}
characters:在场角色名,逗号分隔（必填）
costume:角色名=服装描述（必填，每人一行，禁止分号合并）
item/item!/item!!:见物品规则（触发时才写）
item-:物品名（物品消耗/丢失时删除。见物品规则，触发时才写）
affection:角色名=好感度（★NPC首次出场必填初始值！之后仅好感变化时更新）
npc:角色名|外貌=性格@关系~扩展字段（★NPC首次出场必填完整信息！之后仅变化时更新）
agenda:日期|内容（新待办触发时才写）
agenda-:内容关键词（待办已完成/失效时才写，系统自动移除匹配的待办）${relLine}${moodLine}
</horae>
<horaeevent>
event:重要程度|事件描述（${this._getEventCharLimit()}，重要程度：一般/重要/关键，记录本条消息中的事件摘要，用于剧情追溯）
</horaeevent>

═══ 【事件摘要(event)】撰写规则 ═══
★ 核心目标：为未来的AI提供无损的“前情提要”，必须具体且信息量密集，字数控制在80-150字。
★ 必须包含以下关键要素（5W1H）：
  ① 核心互动：谁对谁做了什么/说了什么关键的话？（写出具体的动作或核心台词大意）
  ② 状态/情绪转变：角色的心理、态度或关系发生了什么微妙变化？（如：从防备转为信任、心生暗恋等）
  ③ 新情报/结果：本回合推进了什么剧情？（获得了什么线索、达成了什么共识、发生了什么变故）
  ④ 伏笔/悬念（若有）：留下了什么未解决的问题？
★ 严禁泛泛而谈：
  ❌ 错误示范："U和艾伦在酒馆聊天，两人聊得很开心，最后约定下次再见。"（毫无细节）
  ✅ 正确示范："U在酒馆向艾伦打听黑市商人的下落，艾伦起初警惕，但在U递出10枚金币后，透露商人明晚会在废弃码头出现。艾伦对U的态度由戒备转为贪婪。两人约定明晚一起行动。"

═══ 【物品】触发条件与规则 ═══
参照[物品清单]中的编号(#ID)，严格按以下条件决定是否输出。

【何时写】（满足任一条件才输出）
  ✦ 获得新物品 → item:/item!:/item!!:
  ✦ 已有物品的数量/归属/位置/性质发生改变 → item:（仅写变化部分）
  ✦ 物品消耗/丢失/用完 → item-:物品名
【何时不写】
  ✗ 物品无任何变化 → 禁止输出任何item行
  ✗ 物品仅被提及但无状态改变 → 不写

【格式】
  新获得：item:emoji物品名(数量)|描述=持有者@精确位置（可省略描述字段。除非该物品有特殊含意，如礼物、纪念品，则添加描述）
  新获得(重要)：item!:emoji物品名(数量)|描述=持有者@精确位置（重要物品，描述必填：外观+功能+来源）
  新获得(关键)：item!!:emoji物品名(数量)|描述=持有者@精确位置（关键道具，描述必须详细）
  已有物品变化：item:emoji物品名(新数量)=新持有者@新位置（仅更新变化的部分，不写|则保留原描述）
  消耗/丢失：item-:物品名

【字段级规则】
  · 描述：记录物品本质属性（外观/功能/来源），普通物品可省略，重要/关键物品首次必填
    ★ 外观特征（颜色、材质、大小等，便于后续一致性描写）
    ★ 功能/用途
    ★ 来源（谁给的/如何获得）
       - 示例（以下内容中若有示例仅为示范，勿直接原句用于正文！）：
         - 示例1：item!:🌹永生花束|深红色玫瑰永生花，黑色缎带束扎，C赠送给U的情人节礼物=U@U房间书桌上
         - 示例2：item!:🎫幸运十连抽券|闪着金光的纸质奖券，可在系统奖池进行一次十连抽的新手福利=U@空间戒指
         - 示例3：item!!:🏧位面货币自动兑换机|看起来像个小型的ATM机，能按即时汇率兑换各位面货币=U@酒馆吧台
  · 数量：单件不写(1)/(1个)/(1把)等，只有计量单位才写括号如(5斤)(1L)(1箱)
  · 位置：必须是精确固定地点
    ❌ 某某人身前地上、某某人脚边、某某人旁边、地板、桌子上
    ✅ 酒馆大厅地板、餐厅吧台上、家中厨房、背包里、U的房间桌子上
  · 禁止将固定家具和建筑设施计入物品
  · 临时借用≠归属转移


示例（麦酒生命周期）：
  获得：item:🍺陈酿麦酒(50L)|杂物间翻出的麦酒，口感酸涩=U@酒馆后厨食材柜
  量变：item:🍺陈酿麦酒(25L)=U@酒馆后厨食材柜
  用完：item-:陈酿麦酒

═══ 【NPC】触发条件与规则 ═══
格式：npc:名|外貌=性格@与{{user}}的关系~性别:值~年龄:值~种族:值~职业:值~生日:值
分隔符：| 分名字，= 分外貌与性格，@ 分关系，~ 分扩展字段(key:value)

【何时写】（满足任一条件才输出该NPC的npc:行）
  ✦ 首次出场 → 完整格式，全部字段+全部~扩展字段（性别/年龄/种族/职业），缺一不可
  ✦ 外貌永久变化（如受伤留疤、换了发型、穿戴改变）→ 只写外貌字段
  ✦ 性格发生转变（如经历重大事件后性格改变）→ 只写性格字段
  ✦ 与{{user}}的关系定位改变（如从客人变成朋友）→ 只写关系字段
  ✦ 获得关于该NPC的新信息（之前不知道的身高/体重等）→ 追加到对应字段
  ✦ ~扩展字段本身发生变化（如职业变了）→ 只写变化的~扩展字段
【何时不写】
  ✗ NPC在场但无新信息 → 禁止写npc:行
  ✗ NPC暂时离场后回来，信息无变化 → 禁止重写
  ✗ 想用同义词/缩写重写已有描述 → 严禁！
    ❌ "肌肉发达/满身战斗伤痕"→"肌肉强壮/伤疤"（换词≠更新）
    ✅ "肌肉发达/满身战斗伤痕/重伤"→"肌肉发达/满身战斗伤痕"（伤愈，移除过时状态）

【增量更新示例】（以NPC沃尔为例）
  首次：npc:沃尔|银灰色披毛/绿眼睛/身高220cm/满身战斗伤痕=沉默寡言的重装佣兵@{{user}}的第一个客人~性别:男~年龄:约35~种族:狼兽人~职业:佣兵
  只更新关系：npc:沃尔|=@{{user}}的男朋友
  只追加外貌：npc:沃尔|银灰色披毛/绿眼睛/身高220cm/满身战斗伤痕/左臂绷带
  只更新性格：npc:沃尔|=不再沉默/偶尔微笑
  只改职业：npc:沃尔|~职业:退役佣兵
（注意：未变化的字段和~扩展字段完全不写！系统自动保留原有数据！）

【生日字段（可选扩展字段）】
  格式：~生日:yyyy/mm/dd 或 ~生日:mm/dd（无年份时仅写月日）
  ⚠ 仅当角色设定/人物描述中明确提及生日日期时才写！严禁猜测或捏造！
  ⚠ 没有明确出处的生日一律不写此字段——留空由用户自行填写。

【关系描述规范】
  必须包含对象名且准确：❌客人 ✅{{user}}的新访客 / ❌债主 ✅持有{{user}}欠条的人 / ❌房东 ✅{{user}}的房东 / ❌男朋友 ✅{{user}}的男朋友 / ❌恩人 ✅救了{{user}}一命的人 / ❌霸凌者 ✅欺负{{user}}的人 / ❌暗恋者 ✅暗恋{{user}}的人 / ❌仇人 ✅被{{user}}杀掉了生父
  附属关系需写出所属NPC名：✅伊凡的猎犬; {{user}}客人的宠物 / 伊凡的女朋友; {{user}}的客人 / {{user}}的闺蜜; 伊凡的妻子 / {{user}}的继父; 伊凡的父亲 / {{user}}的情夫; 伊凡的弟弟 / {{user}}的闺蜜; {{user}}的丈夫的情妇; 插足{{user}}与伊凡夫妻关系的第三者

═══ 【好感度】触发条件 ═══
仅记录NPC对{{user}}的好感度（禁止记录{{user}}自己）。每人一行，禁止数值后加注解。

【何时写】
  ✦ NPC首次出场 → 按关系判定初始值（陌生0-20/熟人30-50/朋友50-70/恋人70-90）
  ✦ 互动导致好感度实质变化 → affection:名=新总值
【何时不写】
  ✗ 好感度无变化 → 不写

═══ 【待办事项】触发条件 ═══
【何时写（新增）】
  ✦ 剧情中出现新的约定/计划/行程/任务/伏笔 → agenda:日期|内容
  格式：agenda:订立日期|内容（相对时间须括号标注绝对日期）
  示例：agenda:2026/02/10|艾伦邀请{{user}}情人节晚上约会(2026/02/14 18:00)
【何时写（完成删除）— 极重要！】
  ✦ 待办事项已完成/已失效/已取消 → 必须用 agenda-: 标记删除
  格式：agenda-:待办内容（写入已完成事项的内容关键词即可自动移除）
  示例：agenda-:艾伦邀请{{user}}情人节晚上约会
  ⚠ 严禁用 agenda:内容(完成) 这种方式！必须用 agenda-: 前缀！
  ⚠ 严禁重复写入已存在的待办内容！
【何时不写】
  ✗ 已有待办无变化 → 禁止每回合重复已有待办
  ✗ 待办已完成 → 禁止用 agenda: 加括号标注完成，必须用 agenda-:

═══ 时间格式规则 ═══
禁止"Day 1"/"第X天"等模糊格式，必须使用具体日历日期。
- 现代：年/月/日 时:分（如 2026/2/4 15:00）
- 历史：该年代日期（如 1920/3/15 14:00）
- 奇幻/架空：该世界观日历（如 霜降月第三日 黄昏）

═══ 最终强制提醒 ═══
${this._generateMustTagsReminder()}

【每回合必写字段——缺任何一项=不合格！】
  ✅ time: ← 当前日期时间
  ✅ location: ← 当前地点
  ✅ atmosphere: ← 氛围
  ✅ characters: ← 当前在场所有角色名，逗号分隔（绝对不能省略！）
  ✅ costume: ← 每个在场角色各一行服装描述
  ✅ event: ← 重要程度|事件摘要

【NPC首次登场时额外必写——缺一不可！】
  ✅ npc:名|外貌=性格@关系~性别:值~年龄:值~种族:值~职业:值~生日:值(仅已知时写，未知不写)
  ✅ affection:该NPC名=初始好感度（陌生0-20/熟人30-50/朋友50-70/恋人70-90）

以上字段不存在"可写可不写"的情况——它们是强制性的。`;
    }

    _getDefaultSystemPromptEn() {
        const sceneDescLine = this.settings?.sendLocationMemory ? '\nscene_desc:fixed physical features of location (see Scene Memory rules, write only when triggered)' : '';
        const relLine = this.settings?.sendRelationships ? '\nrel:CharA>CharB=relationship type|notes (see Relationship rules, write only when triggered)' : '';
        const moodLine = this.settings?.sendMood ? '\nmood:character name=emotion/mental state (see Mood rules, write only when triggered)' : '';
        return `[Horae Memory System] (Examples below are for demonstration only — do NOT copy them into your prose!)

═══ Core Principle: Change-Driven ═══
★★★ Before writing <horae> tags, determine which information ACTUALLY CHANGED this turn ★★★
  ① Scene basics (time/location/characters/costume) → required every turn
  ② All other fields → strictly follow their trigger conditions; if no change, do NOT write that line
  ③ Already-recorded NPCs/items with no new info → do NOT output! Repeating unchanged data = wasting tokens
  ④ Partial changes → use incremental updates, only write what changed
  ⑤ NPC first appearance → both npc: and affection: lines are mandatory!

═══ Tag Format ═══
Append two tags at the end of every reply:
<horae>
time:date time (required)
location:place (required. Use · to separate multi-level locations, e.g. "Tavern·Main Hall" "Palace·Throne Room". Always use the exact same name for the same place)
atmosphere:atmosphere${sceneDescLine}
characters:names of present characters, comma-separated (required)
costume:character name=outfit description (required, one line per person, no semicolons)
item/item!/item!!:see Item rules (only when triggered)
item-:item name (remove consumed/lost items. See Item rules, only when triggered)
affection:character name=affection value (★ required on NPC first appearance! Then only when value changes)
npc:name|appearance=personality@relationship~extended fields (★ required on NPC first appearance! Then only when changed)
agenda:date|content (only when new agenda is created)
agenda-:content keywords (when agenda completed/expired, system auto-removes match)${relLine}${moodLine}
</horae>
<horaeevent>
event:importance|summary (${this._getEventCharLimit()}, importance: normal/important/critical, summarize events in this message for plot tracking)
</horaeevent>

═══ [Items] Trigger Conditions & Rules ═══
Refer to item IDs (#ID) in [Item List]. Only output when conditions below are met.

[When to write] (output only if any condition is met)
  ✦ Acquired new item → item:/item!:/item!!:
  ✦ Existing item's quantity/owner/location/nature changed → item: (only changed parts)
  ✦ Item consumed/lost/depleted → item-:item name
[When NOT to write]
  ✗ No item changes → do NOT output any item line
  ✗ Item merely mentioned without state change → do NOT write

[Format]
  New: item:emoji item name(quantity)|description=owner@exact location (description optional unless item has special significance like a gift or memento)
  New (important): item!:emoji item name(quantity)|description=owner@exact location (important item, description required: appearance+function+source)
  New (critical): item!!:emoji item name(quantity)|description=owner@exact location (critical prop, detailed description required)
  Existing item changed: item:emoji item name(new quantity)=new owner@new location (only update changed parts, omit | to keep original description)
  Consumed/lost: item-:item name

[Field-Level Rules]
  · Description: record essential properties (appearance/function/source). Optional for normal items, required for important/critical items on first occurrence
    ★ Visual features (color, material, size — for consistent future descriptions)
    ★ Function/purpose
    ★ Source (who gave it / how obtained)
       - Examples (demonstrations only, do NOT copy into prose!):
         - Ex1: item!:🌹Eternal Bouquet|deep red preserved roses tied with black satin ribbon, Valentine's gift from C to U=U@desk in U's room
         - Ex2: item!:🎫Lucky 10-Pull Ticket|golden glowing paper voucher, one 10-pull in system gacha as beginner bonus=U@spatial ring
         - Ex3: item!!:🏧Planar Currency ATM|looks like a small ATM, converts currencies across planes at live exchange rates=U@tavern counter
  · Quantity: single items need no (1)/(1pc); only use parentheses for measurements like (5kg)(1L)(1 crate)
  · Location: must be a specific fixed place
    ❌ on the ground in front of someone, beside someone, on the floor, on the table
    ✅ tavern main hall floor, restaurant counter, home kitchen, backpack, on desk in U's room
  · Do NOT list fixed furniture and building fixtures as items
  · Temporary borrowing ≠ ownership transfer


Example (ale lifecycle):
  Acquire: item:🍺Aged Ale(50L)|old ale found in storage, slightly sour taste=U@tavern kitchen pantry
  Quantity change: item:🍺Aged Ale(25L)=U@tavern kitchen pantry
  Depleted: item-:Aged Ale

═══ [NPC] Trigger Conditions & Rules ═══
Format: npc:name|appearance=personality@relationship with {{user}}~gender:value~age:value~race:value~occupation:value~birthday:value
Delimiters: | separates name, = separates appearance and personality, @ separates relationship, ~ separates extended fields (key:value)

[When to write] (output NPC's npc: line only if any condition is met)
  ✦ First appearance → full format with ALL fields and ALL ~extended fields (gender/age/race/occupation), none may be omitted
  ✦ Permanent appearance change (scar, new hairstyle, etc.) → only write appearance field
  ✦ Personality shift (after a major event) → only write personality field
  ✦ Relationship with {{user}} changed (customer → friend) → only write relationship field
  ✦ New info learned about this NPC (previously unknown height/weight) → append to relevant field
  ✦ ~Extended field itself changed (occupation changed) → only write changed ~extended field
[When NOT to write]
  ✗ NPC present but no new information → do NOT write npc: line
  ✗ NPC returns after absence with no changes → do NOT rewrite
  ✗ Want to paraphrase existing description with synonyms → strictly forbidden!
    ❌ "muscular/battle-scarred" → "strong/scarred" (paraphrasing ≠ updating)
    ✅ "muscular/battle-scarred/severely wounded" → "muscular/battle-scarred" (healed, remove outdated status)

[Incremental Update Examples] (using NPC "Wolf" as example)
  First: npc:Wolf|silver-grey fur/green eyes/220cm tall/battle scars=stoic heavy infantry mercenary@{{user}}'s first customer~gender:male~age:~35~race:wolf beastman~occupation:mercenary
  Relationship only: npc:Wolf|=@{{user}}'s boyfriend
  Append appearance: npc:Wolf|silver-grey fur/green eyes/220cm tall/battle scars/left arm bandaged
  Personality only: npc:Wolf|=no longer stoic/occasionally smiles
  Occupation only: npc:Wolf|~occupation:retired mercenary
(Note: Do NOT write unchanged fields and ~extended fields! System automatically preserves original data!)

[Birthday Field (optional extended field)]
  Format: ~birthday:yyyy/mm/dd or ~birthday:mm/dd (month/day only when year is unknown)
  ⚠ Only write when birthday is EXPLICITLY stated in character settings/description! Absolutely NO guessing or fabricating!
  ⚠ If birthday has no explicit source, do NOT write this field — leave it for the user to fill in manually.

[Relationship Description Rules]
  Must include the target name and be accurate: ❌customer ✅{{user}}'s new visitor / ❌creditor ✅person holding {{user}}'s debt / ❌landlord ✅{{user}}'s landlord / ❌boyfriend ✅{{user}}'s boyfriend / ❌savior ✅person who saved {{user}}'s life / ❌bully ✅person who bullies {{user}} / ❌secret admirer ✅person secretly in love with {{user}} / ❌enemy ✅person whose father was killed by {{user}}
  For subordinate relationships include the NPC name: ✅Ivan's hound; {{user}}'s customer's pet / Ivan's girlfriend; {{user}}'s customer / {{user}}'s best friend; Ivan's wife / {{user}}'s stepfather; Ivan's father / {{user}}'s lover; Ivan's brother / {{user}}'s best friend; {{user}}'s husband's mistress; the third party disrupting {{user}} and Ivan's marriage

═══ [Affection] Trigger Conditions ═══
Only record NPC's affection toward {{user}} (never record {{user}} themselves). One line per person. No annotations after the number.

[When to write]
  ✦ NPC first appears → set initial value based on relationship (stranger 0-20 / acquaintance 30-50 / friend 50-70 / lover 70-90)
  ✦ Interaction causes meaningful affection change → affection:name=new total
[When NOT to write]
  ✗ Affection unchanged → do not write

═══ [Agenda] Trigger Conditions ═══
[When to write (new)]
  ✦ New appointment/plan/schedule/quest/foreshadowing in plot → agenda:date|content
  Format: agenda:date established|content (relative time must include absolute date in parentheses)
  Example: agenda:2026/02/10|Allen invited {{user}} for a Valentine's dinner date (2026/02/14 18:00)
[When to write (completion removal) — critical!]
  ✦ Agenda completed/expired/cancelled → MUST use agenda-: to mark deletion
  Format: agenda-:content (write keywords of completed item, system auto-removes match)
  Example: agenda-:Allen invited {{user}} for a Valentine's dinner date
  ⚠ Do NOT use agenda:content(done)! MUST use agenda-: prefix!
  ⚠ Do NOT duplicate existing agenda content!
[When NOT to write]
  ✗ Existing agenda unchanged → do NOT repeat each turn
  ✗ Agenda completed → do NOT mark done with agenda: parentheses, MUST use agenda-:

═══ Time Format Rules ═══
Do NOT use "Day 1"/"Day X" or similar vague formats. Use specific calendar dates.
- Modern: Year/Month/Day Hour:Minute (e.g. 2026/2/4 15:00)
- Historical: Period-appropriate date (e.g. 1920/3/15 14:00)
- Fantasy/fictional: That world's calendar (e.g. Third Day of Frostfall, dusk)

═══ Final Mandatory Reminder ═══
${this._generateMustTagsReminder()}

[Required fields every turn — missing any = fail!]
  ✅ time: ← current date and time
  ✅ location: ← current location
  ✅ atmosphere: ← atmosphere
  ✅ characters: ← all present character names, comma-separated (must NOT be omitted!)
  ✅ costume: ← one line of outfit description per present character
  ✅ event: ← importance|event summary

[Additional required on NPC's first appearance — all mandatory!]
  ✅ npc:name|appearance=personality@relationship~gender:value~age:value~race:value~occupation:value~birthday:value (only when known; if unknown, omit)
  ✅ affection:NPC name=initial affection (stranger 0-20 / acquaintance 30-50 / friend 50-70 / lover 70-90)

These fields are NOT optional — they are mandatory.`;
    }

    _getDefaultSystemPromptJa() {
        const sceneDescLine = this.settings?.sendLocationMemory ? '\nscene_desc:場所の固定的な物理的特徴（シーン記憶ルール参照、トリガー時のみ記述）' : '';
        const relLine = this.settings?.sendRelationships ? '\nrel:キャラA>キャラB=関係タイプ|備考（関係ルール参照、トリガー時のみ記述）' : '';
        const moodLine = this.settings?.sendMood ? '\nmood:キャラクター名=感情/精神状態（ムードルール参照、トリガー時のみ記述）' : '';
        return `[Horae Memory System]（以下の例はデモンストレーション用です——プロズにコピーしないでください！）

═══ 基本原則：変化駆動 ═══
★★★ <horae>タグを記述する前に、このターンで実際に変化した情報を判断してください ★★★
  ① シーン基本情報（time/location/characters/costume）→ 毎ターン必須
  ② その他すべてのフィールド → トリガー条件を厳守；変化がなければそのラインを記述しない
  ③ 既に記録済みで新情報のないNPC/アイテム → 出力しないこと！変化のないデータの繰り返し＝トークンの浪費
  ④ 部分的な変化 → 差分更新のみ、変化した部分のみ記述
  ⑤ NPC初登場時 → npc:行とaffection:行の両方が必須！

═══ タグ形式 ═══
毎回の返信の最後に2つのタグを追加：
<horae>
time:日付 時間（必須）
location:場所（必須。·で階層を区切る 例：「酒場·メインホール」「宮殿·王座の間」。同じ場所には必ず同じ名前を使用）
atmosphere:雰囲気${sceneDescLine}
characters:その場にいるキャラクター名、カンマ区切り（必須）
costume:キャラクター名=服装の説明（必須、一人一行、セミコロン不可）
item/item!/item!!:アイテムルール参照（トリガー時のみ）
item-:アイテム名（消費/喪失したアイテムを削除。アイテムルール参照、トリガー時のみ）
affection:キャラクター名=好感度の値（★NPC初登場時必須！以降は値が変化した時のみ）
npc:名前|外見=性格@関係~拡張フィールド（★NPC初登場時必須！以降は変化した時のみ）
agenda:日付|内容（新しい予定が作成された時のみ）
agenda-:内容のキーワード（予定が完了/期限切れの時、システムが自動的にマッチを削除）${relLine}${moodLine}
</horae>
<horaeevent>
event:重要度|要約（${this._getEventCharLimit()}、重要度：normal/important/critical、このメッセージのイベントをプロット追跡のために要約）
</horaeevent>

═══ [アイテム] トリガー条件とルール ═══
アイテムID（#ID）は[Item List]を参照。以下の条件を満たした場合のみ出力。

[記述するタイミング]（条件のいずれかを満たした場合のみ出力）
  ✦ 新アイテム入手 → item:/item!:/item!!:
  ✦ 既存アイテムの数量/所有者/位置/性質が変化 → item:（変化部分のみ）
  ✦ アイテムが消費/喪失/枯渇 → item-:アイテム名
[記述しないタイミング]
  ✗ アイテムに変化なし → item行を出力しない
  ✗ アイテムが言及されただけで状態変化なし → 記述しない

[形式]
  新規: item:絵文字 アイテム名(数量)|説明=所有者@正確な場所（説明は贈り物や記念品など特別な意味がある場合を除き任意）
  新規（重要）: item!:絵文字 アイテム名(数量)|説明=所有者@正確な場所（重要アイテム、説明必須：外観+機能+入手元）
  新規（極重要）: item!!:絵文字 アイテム名(数量)|説明=所有者@正確な場所（極重要アイテム、詳細な説明必須）
  既存アイテムの変化: item:絵文字 アイテム名(新数量)=新所有者@新場所（変化部分のみ更新、|を省略して元の説明を保持）
  消費/喪失: item-:アイテム名

[フィールドレベルルール]
  · 説明：重要な属性（外観/機能/入手元）を記録。通常アイテムは任意、重要/極重要アイテムは初出時必須
    ★ 視覚的特徴（色、素材、サイズ——将来の一貫した描写のため）
    ★ 機能/用途
    ★ 入手元（誰からもらったか/どう手に入れたか）
       - 例（デモンストレーション用、プロズにコピーしないでください！）：
         - 例1: item!:🌹永遠の花束|深紅のプリザーブドローズに黒いサテンリボン、CからUへのバレンタインギフト=U@Uの部屋の机の上
         - 例2: item!:🎫幸運の10連チケット|金色に光る紙のバウチャー、初心者ボーナスとしてシステムガチャ1回分=U@空間リング
         - 例3: item!!:🏧次元間通貨ATM|小型ATMのような外見、リアルタイム為替レートで異次元間の通貨を変換=U@酒場カウンター
  · 数量：単品は(1)/(1個)不要；(5kg)(1L)(1箱)のような計量単位のみ括弧使用
  · 場所：具体的な固定場所でなければならない
    ❌ 誰かの前の地面、誰かの隣、床の上、テーブルの上
    ✅ 酒場メインホールの床、レストランカウンター、自宅キッチン、バックパック、Uの部屋の机の上
  · 固定家具や建物の備品をアイテムとしてリストしない
  · 一時的な借用 ≠ 所有権の移転


例（エールのライフサイクル）：
  入手: item:🍺熟成エール(50L)|貯蔵庫で見つけた古いエール、やや酸味あり=U@酒場キッチンのパントリー
  数量変化: item:🍺熟成エール(25L)=U@酒場キッチンのパントリー
  枯渇: item-:熟成エール

═══ [NPC] トリガー条件とルール ═══
形式: npc:名前|外見=性格@{{user}}との関係~gender:値~age:値~race:値~occupation:値~birthday:値
区切り文字: |は名前を区切り、=は外見と性格を区切り、@は関係を区切り、~は拡張フィールド(key:value)を区切る

[記述するタイミング]（以下の条件のいずれかを満たした場合のみNPCのnpc:行を出力）
  ✦ 初登場 → すべてのフィールドとすべての~拡張フィールド（gender/age/race/occupation）を含む完全形式、省略不可
  ✦ 永続的な外見の変化（傷跡、新しい髪型など） → 外見フィールドのみ記述
  ✦ 性格の変化（重大な出来事の後） → 性格フィールドのみ記述
  ✦ {{user}}との関係が変化（客 → 友人） → 関係フィールドのみ記述
  ✦ このNPCに関する新情報を学習（以前不明だった身長/体重） → 該当フィールドに追記
  ✦ ~拡張フィールド自体が変化（職業変更） → 変化した~拡張フィールドのみ記述
[記述しないタイミング]
  ✗ NPCがいるが新情報なし → npc:行を記述しない
  ✗ NPCが不在後に変化なく復帰 → 再記述しない
  ✗ 既存の説明を類語で言い換えたい → 厳禁！
    ❌ 「筋骨隆々/戦傷あり」→「強い/傷あり」（言い換え ≠ 更新）
    ✅ 「筋骨隆々/戦傷あり/重傷」→「筋骨隆々/戦傷あり」（治癒、古いステータスを削除）

[差分更新の例]（NPC「ヴォルフ」を例として）
  初回: npc:ヴォルフ|銀灰色の毛並み/緑の瞳/身長220cm/戦傷=寡黙な重歩兵傭兵@{{user}}の最初の客~gender:男性~age:~35~race:狼獣人~occupation:傭兵
  関係のみ: npc:ヴォルフ|=@{{user}}の恋人
  外見追記: npc:ヴォルフ|銀灰色の毛並み/緑の瞳/身長220cm/戦傷/左腕に包帯
  性格のみ: npc:ヴォルフ|=寡黙でなくなり/時折微笑む
  職業のみ: npc:ヴォルフ|~occupation:引退した傭兵
（注意：変化のないフィールドや~拡張フィールドを記述しないでください！システムが自動的にオリジナルデータを保持します！）

[誕生日フィールド（任意の拡張フィールド）]
  形式: ~birthday:yyyy/mm/dd または ~birthday:mm/dd（年が不明な場合は月/日のみ）
  ⚠ 誕生日がキャラクター設定/説明で明示されている場合のみ記述！絶対に推測や捏造をしないでください！
  ⚠ 誕生日に明確な出典がない場合、このフィールドを記述しないでください——ユーザーが手動で入力するのを待ってください。

[関係の説明ルール]
  対象名を含み正確に記述すること：❌客 ✅{{user}}の新しい来訪者 / ❌債権者 ✅{{user}}の借金を持つ人物 / ❌大家 ✅{{user}}の大家 / ❌恋人 ✅{{user}}の恋人 / ❌恩人 ✅{{user}}の命を救った人物 / ❌いじめっ子 ✅{{user}}をいじめる人物 / ❌秘密の崇拝者 ✅{{user}}に密かに恋している人物 / ❌敵 ✅{{user}}に父親を殺された人物
  従属関係にはNPC名を含める：✅イワンの猟犬；{{user}}の客のペット / イワンの恋人；{{user}}の客 / {{user}}の親友；イワンの妻 / {{user}}の義父；イワンの父 / {{user}}の恋人；イワンの兄弟 / {{user}}の親友；{{user}}の夫の愛人；{{user}}とイワンの結婚を壊す第三者

═══ [好感度] トリガー条件 ═══
NPCの{{user}}に対する好感度のみ記録（{{user}}自身は記録しない）。一人一行。数値の後に注釈をつけない。

[記述するタイミング]
  ✦ NPC初登場 → 関係に基づき初期値を設定（他人 0-20 / 知人 30-50 / 友人 50-70 / 恋人 70-90）
  ✦ 交流により意味のある好感度変化 → affection:名前=新しい合計値
[記述しないタイミング]
  ✗ 好感度に変化なし → 記述しない

═══ [予定] トリガー条件 ═══
[記述するタイミング（新規）]
  ✦ プロットに新しい約束/計画/スケジュール/クエスト/伏線 → agenda:日付|内容
  形式: agenda:設定日|内容（相対時間には絶対日付を括弧内に含める）
  例: agenda:2026/02/10|アレンが{{user}}をバレンタインディナーデートに招待（2026/02/14 18:00）
[記述するタイミング（完了削除）——重要！]
  ✦ 予定が完了/期限切れ/キャンセル → 必ずagenda-:で削除をマーク
  形式: agenda-:内容（完了した項目のキーワードを記述、システムが自動的にマッチを削除）
  例: agenda-:アレンが{{user}}をバレンタインディナーデートに招待
  ⚠ agenda:内容(完了)を使用しないでください！必ずagenda-:プレフィックスを使用！
  ⚠ 既存の予定内容を重複させないでください！
[記述しないタイミング]
  ✗ 既存の予定に変化なし → 毎ターン繰り返さない
  ✗ 予定が完了 → agenda:の括弧で完了をマークしない、必ずagenda-:を使用

═══ 時間形式ルール ═══
「1日目」/「X日目」などの曖昧な形式を使用しないでください。具体的なカレンダー日付を使用。
- 現代：年/月/日 時:分（例：2026/2/4 15:00）
- 歴史：時代に適した日付（例：1920/3/15 14:00）
- ファンタジー/架空：その世界のカレンダー（例：霜降月の第三日、夕暮れ）

═══ 最終必須リマインダー ═══
${this._generateMustTagsReminder()}

[毎ターン必須フィールド——一つでも欠けたら失格！]
  ✅ time: ← 現在の日付と時間
  ✅ location: ← 現在の場所
  ✅ atmosphere: ← 雰囲気
  ✅ characters: ← その場にいるすべてのキャラクター名、カンマ区切り（省略不可！）
  ✅ costume: ← キャラクターごとに一行の服装説明
  ✅ event: ← 重要度|イベント要約

[NPC初登場時の追加必須——すべて必須！]
  ✅ npc:名前|外見=性格@関係~gender:値~age:値~race:値~occupation:値~birthday:値（既知の場合のみ；不明の場合は省略）
  ✅ affection:NPC名=初期好感度（他人 0-20 / 知人 30-50 / 友人 50-70 / 恋人 70-90）

以上のフィールドは任意ではありません——すべて必須です。`;
    }

    _getDefaultSystemPromptKo() {
        const sceneDescLine = this.settings?.sendLocationMemory ? '\nscene_desc:장소의 고정된 물리적 특징 (씬 메모리 규칙 참조, 트리거 시에만 작성)' : '';
        const relLine = this.settings?.sendRelationships ? '\nrel:캐릭터A>캐릭터B=관계 유형|비고 (관계 규칙 참조, 트리거 시에만 작성)' : '';
        const moodLine = this.settings?.sendMood ? '\nmood:캐릭터 이름=감정/정신 상태 (무드 규칙 참조, 트리거 시에만 작성)' : '';
        return `[Horae Memory System] (아래 예시는 데모용입니다 — 본문에 복사하지 마세요!)

═══ 핵심 원칙: 변화 기반 ═══
★★★ <horae> 태그를 작성하기 전에, 이번 턴에서 실제로 변경된 정보를 판단하세요 ★★★
  ① 씬 기본 정보 (time/location/characters/costume) → 매 턴 필수
  ② 기타 모든 필드 → 트리거 조건을 엄격히 준수; 변화가 없으면 해당 라인을 작성하지 마세요
  ③ 이미 기록된 NPC/아이템에 새로운 정보가 없으면 → 출력하지 마세요! 변경되지 않은 데이터 반복 = 토큰 낭비
  ④ 부분적 변화 → 증분 업데이트만, 변경된 부분만 작성
  ⑤ NPC 첫 등장 시 → npc:와 affection: 라인 모두 필수!

═══ 태그 형식 ═══
모든 답변 끝에 두 개의 태그를 추가:
<horae>
time:날짜 시간 (필수)
location:장소 (필수. ·로 다중 레벨 장소를 구분, 예: "선술집·메인홀" "궁전·왕좌의 방". 같은 장소에는 반드시 같은 이름을 사용)
atmosphere:분위기${sceneDescLine}
characters:현재 있는 캐릭터 이름, 쉼표 구분 (필수)
costume:캐릭터 이름=복장 설명 (필수, 1인 1줄, 세미콜론 사용 금지)
item/item!/item!!:아이템 규칙 참조 (트리거 시에만)
item-:아이템 이름 (소비/분실 아이템 제거. 아이템 규칙 참조, 트리거 시에만)
affection:캐릭터 이름=호감도 값 (★NPC 첫 등장 시 필수! 이후 값 변경 시에만)
npc:이름|외모=성격@관계~확장 필드 (★NPC 첫 등장 시 필수! 이후 변경 시에만)
agenda:날짜|내용 (새 일정 생성 시에만)
agenda-:내용 키워드 (일정 완료/만료 시, 시스템이 자동으로 매치 삭제)${relLine}${moodLine}
</horae>
<horaeevent>
event:중요도|요약 (${this._getEventCharLimit()}, 중요도: normal/important/critical, 이 메시지의 이벤트를 플롯 추적을 위해 요약)
</horaeevent>

═══ [아이템] 트리거 조건 및 규칙 ═══
아이템 ID (#ID)는 [Item List]를 참조. 아래 조건을 충족할 때만 출력.

[작성 시점] (조건 중 하나라도 충족되면 출력)
  ✦ 새 아이템 획득 → item:/item!:/item!!:
  ✦ 기존 아이템의 수량/소유자/위치/성질 변경 → item: (변경된 부분만)
  ✦ 아이템 소비/분실/소진 → item-:아이템 이름
[작성하지 않을 시점]
  ✗ 아이템 변화 없음 → item 라인을 출력하지 마세요
  ✗ 아이템이 언급만 되고 상태 변화 없음 → 작성하지 마세요

[형식]
  신규: item:이모지 아이템 이름(수량)|설명=소유자@정확한 장소 (설명은 선물이나 기념품 등 특별한 의미가 없으면 선택사항)
  신규 (중요): item!:이모지 아이템 이름(수량)|설명=소유자@정확한 장소 (중요 아이템, 설명 필수: 외관+기능+출처)
  신규 (극중요): item!!:이모지 아이템 이름(수량)|설명=소유자@정확한 장소 (극중요 소품, 상세 설명 필수)
  기존 아이템 변경: item:이모지 아이템 이름(새 수량)=새 소유자@새 장소 (변경된 부분만 업데이트, |를 생략하여 원래 설명 유지)
  소비/분실: item-:아이템 이름

[필드별 규칙]
  · 설명: 핵심 속성 (외관/기능/출처)을 기록. 일반 아이템은 선택사항, 중요/극중요 아이템은 첫 등장 시 필수
    ★ 시각적 특징 (색상, 재질, 크기 — 향후 일관된 묘사를 위해)
    ★ 기능/용도
    ★ 출처 (누구에게 받았는지 / 어떻게 얻었는지)
       - 예시 (데모용, 본문에 복사하지 마세요!):
         - 예1: item!:🌹영원의 꽃다발|짙은 빨간색 프리저브드 장미에 검은 새틴 리본, C가 U에게 준 발렌타인 선물=U@U의 방 책상 위
         - 예2: item!:🎫행운의 10연차 티켓|금빛으로 빛나는 종이 바우처, 초보자 보너스로 시스템 가챠 1회 제공=U@공간 반지
         - 예3: item!!:🏧차원간 통화 ATM|소형 ATM처럼 생긴 기기, 실시간 환율로 차원 간 통화 변환=U@선술집 카운터
  · 수량: 단일 아이템은 (1)/(1개) 불필요; (5kg)(1L)(1상자) 같은 계량 단위에만 괄호 사용
  · 위치: 구체적인 고정 장소여야 함
    ❌ 누군가 앞 바닥, 누군가 옆, 바닥 위, 테이블 위
    ✅ 선술집 메인홀 바닥, 레스토랑 카운터, 자택 주방, 배낭, U의 방 책상 위
  · 고정 가구 및 건물 비품을 아이템으로 등록하지 마세요
  · 일시적 대여 ≠ 소유권 이전


예시 (에일 수명주기):
  획득: item:🍺숙성 에일(50L)|저장고에서 발견한 오래된 에일, 약간 신맛=U@선술집 주방 식료품실
  수량 변화: item:🍺숙성 에일(25L)=U@선술집 주방 식료품실
  소진: item-:숙성 에일

═══ [NPC] 트리거 조건 및 규칙 ═══
형식: npc:이름|외모=성격@{{user}}와의 관계~gender:값~age:값~race:값~occupation:값~birthday:값
구분자: |는 이름 구분, =는 외모와 성격 구분, @는 관계 구분, ~는 확장 필드 (key:value) 구분

[작성 시점] (아래 조건 중 하나라도 충족 시 NPC의 npc: 라인 출력)
  ✦ 첫 등장 → 모든 필드와 모든 ~확장 필드 (gender/age/race/occupation)를 포함한 완전한 형식, 생략 불가
  ✦ 영구적 외모 변화 (흉터, 새 헤어스타일 등) → 외모 필드만 작성
  ✦ 성격 변화 (중대한 사건 이후) → 성격 필드만 작성
  ✦ {{user}}와의 관계 변화 (손님 → 친구) → 관계 필드만 작성
  ✦ 이 NPC에 대한 새 정보 학습 (이전에 알려지지 않은 키/몸무게) → 해당 필드에 추가
  ✦ ~확장 필드 자체 변화 (직업 변경) → 변경된 ~확장 필드만 작성
[작성하지 않을 시점]
  ✗ NPC가 있지만 새 정보 없음 → npc: 라인 작성 금지
  ✗ NPC가 부재 후 변화 없이 복귀 → 재작성 금지
  ✗ 기존 설명을 유의어로 바꾸고 싶음 → 엄격히 금지!
    ❌ "근육질/전투 상흔" → "강인한/상처 있는" (바꿔쓰기 ≠ 업데이트)
    ✅ "근육질/전투 상흔/중상" → "근육질/전투 상흔" (치유됨, 오래된 상태 삭제)

[증분 업데이트 예시] (NPC "볼프"를 예시로)
  첫 등장: npc:볼프|은회색 털/녹색 눈/키 220cm/전투 상흔=과묵한 중보병 용병@{{user}}의 첫 번째 손님~gender:남성~age:~35~race:늑대 수인~occupation:용병
  관계만: npc:볼프|=@{{user}}의 연인
  외모 추가: npc:볼프|은회색 털/녹색 눈/키 220cm/전투 상흔/왼팔 붕대
  성격만: npc:볼프|=더 이상 과묵하지 않음/가끔 미소를 지음
  직업만: npc:볼프|~occupation:은퇴한 용병
(주의: 변경되지 않은 필드와 ~확장 필드를 작성하지 마세요! 시스템이 자동으로 원본 데이터를 보존합니다!)

[생일 필드 (선택적 확장 필드)]
  형식: ~birthday:yyyy/mm/dd 또는 ~birthday:mm/dd (연도를 모를 때 월/일만)
  ⚠ 생일이 캐릭터 설정/설명에 명시된 경우에만 작성! 절대로 추측하거나 지어내지 마세요!
  ⚠ 생일에 명확한 출처가 없으면 이 필드를 작성하지 마세요 — 사용자가 수동으로 입력할 수 있도록 남겨두세요.

[관계 설명 규칙]
  대상 이름을 포함하고 정확해야 합니다: ❌손님 ✅{{user}}의 새 방문객 / ❌채권자 ✅{{user}}의 빚을 가진 사람 / ❌집주인 ✅{{user}}의 집주인 / ❌남자친구 ✅{{user}}의 남자친구 / ❌은인 ✅{{user}}의 생명을 구한 사람 / ❌괴롭히는 자 ✅{{user}}를 괴롭히는 사람 / ❌비밀 흠모자 ✅{{user}}를 몰래 좋아하는 사람 / ❌적 ✅{{user}}에게 아버지를 잃은 사람
  종속 관계에는 NPC 이름 포함: ✅이반의 사냥개; {{user}}의 손님의 반려동물 / 이반의 여자친구; {{user}}의 손님 / {{user}}의 절친한 친구; 이반의 아내 / {{user}}의 양아버지; 이반의 아버지 / {{user}}의 연인; 이반의 형제 / {{user}}의 절친한 친구; {{user}}의 남편의 정부; {{user}}와 이반의 결혼을 파괴하는 제삼자

═══ [호감도] 트리거 조건 ═══
NPC의 {{user}}에 대한 호감도만 기록 ({{user}} 자신은 기록하지 않음). 1인 1줄. 숫자 뒤에 주석을 달지 마세요.

[작성 시점]
  ✦ NPC 첫 등장 → 관계에 따라 초기값 설정 (낯선 사람 0-20 / 지인 30-50 / 친구 50-70 / 연인 70-90)
  ✦ 상호작용으로 의미 있는 호감도 변화 → affection:이름=새 합계 값
[작성하지 않을 시점]
  ✗ 호감도 변화 없음 → 작성하지 마세요

═══ [일정] 트리거 조건 ═══
[작성 시점 (신규)]
  ✦ 플롯에 새 약속/계획/일정/퀘스트/복선 → agenda:날짜|내용
  형식: agenda:설정일|내용 (상대 시간은 절대 날짜를 괄호 안에 포함)
  예시: agenda:2026/02/10|앨런이 {{user}}를 발렌타인 디너 데이트에 초대 (2026/02/14 18:00)
[작성 시점 (완료 삭제) — 중요!]
  ✦ 일정 완료/만료/취소 → 반드시 agenda-:로 삭제 표시
  형식: agenda-:내용 (완료된 항목의 키워드를 작성, 시스템이 자동으로 매치 삭제)
  예시: agenda-:앨런이 {{user}}를 발렌타인 디너 데이트에 초대
  ⚠ agenda:내용(완료)를 사용하지 마세요! 반드시 agenda-: 접두사를 사용!
  ⚠ 기존 일정 내용을 중복하지 마세요!
[작성하지 않을 시점]
  ✗ 기존 일정 변화 없음 → 매 턴 반복 금지
  ✗ 일정 완료 → agenda:의 괄호로 완료 표시 금지, 반드시 agenda-: 사용

═══ 시간 형식 규칙 ═══
"1일차"/"X일차" 등 모호한 형식을 사용하지 마세요. 구체적인 달력 날짜를 사용.
- 현대: 년/월/일 시:분 (예: 2026/2/4 15:00)
- 역사: 시대에 적합한 날짜 (예: 1920/3/15 14:00)
- 판타지/가상: 해당 세계의 달력 (예: 서리달의 셋째 날, 해질녘)

═══ 최종 필수 리마인더 ═══
${this._generateMustTagsReminder()}

[매 턴 필수 필드 — 하나라도 빠지면 실격!]
  ✅ time: ← 현재 날짜와 시간
  ✅ location: ← 현재 장소
  ✅ atmosphere: ← 분위기
  ✅ characters: ← 현재 있는 모든 캐릭터 이름, 쉼표 구분 (생략 불가!)
  ✅ costume: ← 캐릭터당 한 줄의 복장 설명
  ✅ event: ← 중요도|이벤트 요약

[NPC 첫 등장 시 추가 필수 — 모두 필수!]
  ✅ npc:이름|외모=성격@관계~gender:값~age:값~race:값~occupation:값~birthday:값 (알려진 경우에만; 모르면 생략)
  ✅ affection:NPC 이름=초기 호감도 (낯선 사람 0-20 / 지인 30-50 / 친구 50-70 / 연인 70-90)

위 필드는 선택사항이 아닙니다 — 모두 필수입니다.`;
    }

    _getDefaultSystemPromptRu() {
        const sceneDescLine = this.settings?.sendLocationMemory ? '\nscene_desc:фиксированные физические характеристики локации (см. правила памяти сцен, писать только при срабатывании)' : '';
        const relLine = this.settings?.sendRelationships ? '\nrel:ПерсА>ПерсБ=тип отношений|заметки (см. правила отношений, писать только при срабатывании)' : '';
        const moodLine = this.settings?.sendMood ? '\nmood:имя персонажа=эмоция/психическое состояние (см. правила настроения, писать только при срабатывании)' : '';
        return `[Horae Memory System] (Примеры ниже даны только для демонстрации — НЕ копируйте их в текст!)

═══ Основной принцип: Управление изменениями ═══
★★★ Перед записью тегов <horae> определите, какая информация ДЕЙСТВИТЕЛЬНО ИЗМЕНИЛАСЬ в этом ходу ★★★
  ① Базовая информация сцены (time/location/characters/costume) → обязательно каждый ход
  ② Все остальные поля → строго следуйте условиям срабатывания; если нет изменений, НЕ пишите эту строку
  ③ Уже записанные NPC/предметы без новой информации → НЕ выводить! Повторение неизменённых данных = трата токенов
  ④ Частичные изменения → инкрементальные обновления, пишите только то, что изменилось
  ⑤ Первое появление NPC → обязательны обе строки npc: и affection:!

═══ Формат тегов ═══
Добавляйте два тега в конце каждого ответа:
<horae>
time:дата время (обязательно)
location:место (обязательно. Используйте · для разделения многоуровневых локаций, напр. «Таверна·Главный зал» «Дворец·Тронный зал». Всегда используйте одно и то же название для одного места)
atmosphere:атмосфера${sceneDescLine}
characters:имена присутствующих персонажей через запятую (обязательно)
costume:имя персонажа=описание костюма (обязательно, одна строка на персонажа, без точек с запятой)
item/item!/item!!:см. правила предметов (только при срабатывании)
item-:название предмета (удалить потреблённые/утерянные предметы. См. правила предметов, только при срабатывании)
affection:имя персонажа=значение привязанности (★ обязательно при первом появлении NPC! Далее только при изменении значения)
npc:имя|внешность=характер@отношения~расширенные поля (★ обязательно при первом появлении NPC! Далее только при изменении)
agenda:дата|содержание (только при создании нового расписания)
agenda-:ключевые слова содержания (при завершении/истечении расписания, система автоматически удаляет совпадение)${relLine}${moodLine}
</horae>
<horaeevent>
event:важность|краткое содержание (${this._getEventCharLimit()}, важность: normal/important/critical, резюмируйте события этого сообщения для отслеживания сюжета)
</horaeevent>

═══ [Предметы] Условия срабатывания и правила ═══
ID предметов (#ID) см. в [Item List]. Выводить только при выполнении условий ниже.

[Когда писать] (выводить только при выполнении хотя бы одного условия)
  ✦ Получен новый предмет → item:/item!:/item!!:
  ✦ Изменилось количество/владелец/местоположение/свойства существующего предмета → item: (только изменённые части)
  ✦ Предмет израсходован/утерян/исчерпан → item-:название предмета
[Когда НЕ писать]
  ✗ Нет изменений предметов → НЕ выводить строку item
  ✗ Предмет только упомянут без изменения состояния → НЕ писать

[Формат]
  Новый: item:эмодзи название предмета(кол-во)|описание=владелец@точное место (описание необязательно, если предмет не имеет особого значения, как подарок или памятная вещь)
  Новый (важный): item!:эмодзи название предмета(кол-во)|описание=владелец@точное место (важный предмет, описание обязательно: внешний вид+функция+источник)
  Новый (критический): item!!:эмодзи название предмета(кол-во)|описание=владелец@точное место (критический реквизит, подробное описание обязательно)
  Изменение существующего: item:эмодзи название предмета(новое кол-во)=новый владелец@новое место (обновлять только изменённые части, опустить | для сохранения исходного описания)
  Израсходован/утерян: item-:название предмета

[Правила на уровне полей]
  · Описание: записывайте существенные свойства (внешний вид/функция/источник). Необязательно для обычных предметов, обязательно для важных/критических при первом появлении
    ★ Визуальные характеристики (цвет, материал, размер — для последовательного описания в будущем)
    ★ Функция/назначение
    ★ Источник (от кого получен / как добыт)
       - Примеры (только для демонстрации, НЕ копируйте в текст!):
         - Пр1: item!:🌹Вечный букет|тёмно-красные стабилизированные розы, перевязанные чёрной атласной лентой, подарок C для U на День святого Валентина=U@стол в комнате U
         - Пр2: item!:🎫Счастливый билет на 10 круток|золотистый светящийся бумажный ваучер, одна 10-кратная крутка в системной гаче как бонус новичка=U@пространственное кольцо
         - Пр3: item!!:🏧Межмировой валютный банкомат|выглядит как маленький банкомат, конвертирует валюты между мирами по курсу в реальном времени=U@стойка таверны
  · Количество: для единичных предметов не нужно (1)/(1шт); скобки только для единиц измерения вроде (5кг)(1л)(1 ящик)
  · Местоположение: должно быть конкретным фиксированным местом
    ❌ на полу перед кем-то, рядом с кем-то, на полу, на столе
    ✅ пол главного зала таверны, стойка ресторана, домашняя кухня, рюкзак, на столе в комнате U
  · НЕ включайте стационарную мебель и встроенные элементы зданий как предметы
  · Временное одалживание ≠ передача права собственности


Пример (жизненный цикл эля):
  Получение: item:🍺Выдержанный эль(50л)|старый эль из подвала, слегка кисловатый вкус=U@кладовая кухни таверны
  Изменение количества: item:🍺Выдержанный эль(25л)=U@кладовая кухни таверны
  Исчерпан: item-:Выдержанный эль

═══ [NPC] Условия срабатывания и правила ═══
Формат: npc:имя|внешность=характер@отношения с {{user}}~gender:значение~age:значение~race:значение~occupation:значение~birthday:значение
Разделители: | разделяет имя, = разделяет внешность и характер, @ разделяет отношения, ~ разделяет расширенные поля (key:значение)

[Когда писать] (выводить строку npc: NPC только при выполнении хотя бы одного условия)
  ✦ Первое появление → полный формат со ВСЕМИ полями и ВСЕМИ ~расширенными полями (gender/age/race/occupation), ничего нельзя пропускать
  ✦ Постоянное изменение внешности (шрам, новая причёска и т.д.) → писать только поле внешности
  ✦ Изменение характера (после крупного события) → писать только поле характера
  ✦ Отношения с {{user}} изменились (клиент → друг) → писать только поле отношений
  ✦ Узнана новая информация об этом NPC (ранее неизвестные рост/вес) → добавить в соответствующее поле
  ✦ Изменилось само ~расширенное поле (смена профессии) → писать только изменённое ~расширенное поле
[Когда НЕ писать]
  ✗ NPC присутствует, но нет новой информации → НЕ писать строку npc:
  ✗ NPC вернулся после отсутствия без изменений → НЕ переписывать
  ✗ Хотите перефразировать существующее описание синонимами → строго запрещено!
    ❌ «мускулистый/с боевыми шрамами» → «сильный/со шрамами» (перефразирование ≠ обновление)
    ✅ «мускулистый/с боевыми шрамами/тяжело ранен» → «мускулистый/с боевыми шрамами» (исцелился, удалить устаревший статус)

[Примеры инкрементального обновления] (на примере NPC «Вольф»)
  Первое: npc:Вольф|серебристо-серая шерсть/зелёные глаза/рост 220 см/боевые шрамы=немногословный тяжёлый пехотинец-наёмник@первый клиент {{user}}~gender:мужской~age:~35~race:волк-зверолюд~occupation:наёмник
  Только отношения: npc:Вольф|=@парень {{user}}
  Добавление внешности: npc:Вольф|серебристо-серая шерсть/зелёные глаза/рост 220 см/боевые шрамы/левая рука перевязана
  Только характер: npc:Вольф|=больше не немногословен/иногда улыбается
  Только профессия: npc:Вольф|~occupation:наёмник в отставке
(Примечание: НЕ пишите неизменённые поля и ~расширенные поля! Система автоматически сохраняет исходные данные!)

[Поле дня рождения (необязательное расширенное поле)]
  Формат: ~birthday:гггг/мм/дд или ~birthday:мм/дд (только месяц/день, если год неизвестен)
  ⚠ Писать только когда день рождения ЯВНО указан в настройках/описании персонажа! Категорически запрещено угадывать или выдумывать!
  ⚠ Если у дня рождения нет явного источника, НЕ заполняйте это поле — оставьте для ручного ввода пользователем.

[Правила описания отношений]
  Должны включать имя объекта и быть точными: ❌клиент ✅новый посетитель {{user}} / ❌кредитор ✅человек, которому {{user}} должен / ❌арендодатель ✅арендодатель {{user}} / ❌парень ✅парень {{user}} / ❌спаситель ✅человек, спасший жизнь {{user}} / ❌хулиган ✅человек, который издевается над {{user}} / ❌тайный поклонник ✅человек, тайно влюблённый в {{user}} / ❌враг ✅человек, чей отец был убит {{user}}
  Для подчинённых отношений включать имя NPC: ✅гончая Ивана; питомец клиента {{user}} / подруга Ивана; клиент {{user}} / лучшая подруга {{user}}; жена Ивана / отчим {{user}}; отец Ивана / возлюбленный(-ая) {{user}}; брат Ивана / лучшая подруга {{user}}; любовница мужа {{user}}; третье лицо, разрушающее брак {{user}} и Ивана

═══ [Привязанность] Условия срабатывания ═══
Записывать только привязанность NPC к {{user}} (никогда не записывать самого {{user}}). Одна строка на персонажа. Никаких примечаний после числа.

[Когда писать]
  ✦ Первое появление NPC → установить начальное значение на основе отношений (незнакомец 0-20 / знакомый 30-50 / друг 50-70 / возлюбленный 70-90)
  ✦ Взаимодействие вызвало значимое изменение привязанности → affection:имя=новое суммарное значение
[Когда НЕ писать]
  ✗ Привязанность не изменилась → не писать

═══ [Расписание] Условия срабатывания ═══
[Когда писать (новое)]
  ✦ Новая встреча/план/расписание/квест/завязка в сюжете → agenda:дата|содержание
  Формат: agenda:дата создания|содержание (относительное время должно включать абсолютную дату в скобках)
  Пример: agenda:2026/02/10|Аллен пригласил {{user}} на ужин в День святого Валентина (2026/02/14 18:00)
[Когда писать (удаление при завершении) — критически важно!]
  ✦ Расписание выполнено/истекло/отменено → ОБЯЗАТЕЛЬНО использовать agenda-: для пометки удаления
  Формат: agenda-:содержание (напишите ключевые слова выполненного пункта, система автоматически удалит совпадение)
  Пример: agenda-:Аллен пригласил {{user}} на ужин в День святого Валентина
  ⚠ НЕ используйте agenda:содержание(выполнено)! ОБЯЗАТЕЛЬНО используйте префикс agenda-:!
  ⚠ НЕ дублируйте содержание существующего расписания!
[Когда НЕ писать]
  ✗ Существующее расписание не изменилось → НЕ повторять каждый ход
  ✗ Расписание выполнено → НЕ помечать выполненным через скобки agenda:, ОБЯЗАТЕЛЬНО использовать agenda-:

═══ Правила формата времени ═══
НЕ используйте «День 1»/«День X» и подобные размытые форматы. Используйте конкретные календарные даты.
- Современность: Год/Месяц/День Час:Минута (напр. 2026/2/4 15:00)
- Исторический: Дата, соответствующая эпохе (напр. 1920/3/15 14:00)
- Фэнтези/вымышленный: Календарь этого мира (напр. Третий день Месяца Морозов, закат)

═══ Финальное обязательное напоминание ═══
${this._generateMustTagsReminder()}

[Обязательные поля каждый ход — пропуск любого = провал!]
  ✅ time: ← текущая дата и время
  ✅ location: ← текущее местоположение
  ✅ atmosphere: ← атмосфера
  ✅ characters: ← имена всех присутствующих персонажей через запятую (нельзя пропускать!)
  ✅ costume: ← одна строка описания костюма на каждого персонажа
  ✅ event: ← важность|краткое содержание события

[Дополнительно обязательно при первом появлении NPC — всё обязательно!]
  ✅ npc:имя|внешность=характер@отношения~gender:значение~age:значение~race:значение~occupation:значение~birthday:значение (только если известно; если неизвестно, не писать)
  ✅ affection:имя NPC=начальная привязанность (незнакомец 0-20 / знакомый 30-50 / друг 50-70 / возлюбленный 70-90)

Эти поля НЕ являются необязательными — они обязательны.`;
    }

    getDefaultTablesPrompt() {
        const lang = this._getAiOutputLang();
        if (lang === 'ja') return this._getDefaultTablesPromptJa();
        if (lang === 'ko') return this._getDefaultTablesPromptKo();
        if (lang === 'ru') return this._getDefaultTablesPromptRu();
        if (lang !== 'zh-CN' && lang !== 'zh-TW') return this._getDefaultTablesPromptEn();
        return `═══ 自定义表格规则 ═══
上方有用户自定义表格，根据"填写要求"填写数据。
★ 格式：<horaetable:表格名> 标签内，每行一个单元格 → 行,列:内容
★★ 坐标说明：第0行和第0列是表头，数据从1,1开始。行号=数据行序号，列号=数据列序号
★★★ 填写原则 ★★★
  - 空单元格且剧情中已有对应信息 → 必须填写！不要遗漏！
  - 已有内容且无变化 → 不重复写
  - 该行/列确实无对应剧情信息 → 留空
  - 禁止输出"(空)""-""无"等占位符
  - 🔒标记的行/列为只读数据，禁止修改其内容
  - 新增行请在现有最大行号之后追加，新增列请在现有最大列号之后追加`;
    }

    _getDefaultTablesPromptEn() {
        return `═══ Custom Table Rules ═══
There are user-defined tables above. Fill in data according to the "Fill Requirements".
★ Format: Inside <horaetable:table name> tags, one cell per line → row,col:content
★★ Coordinates: Row 0 and Column 0 are headers. Data starts from 1,1. Row number = data row index, column number = data column index
★★★ Filling Rules ★★★
  - Empty cell with relevant plot info available → MUST fill! Do not miss!
  - Existing content with no change → do not rewrite
  - No relevant plot info for this row/col → leave empty
  - Do NOT output "(empty)" "-" "none" as placeholders
  - 🔒 marked rows/columns are read-only, do NOT modify their content
  - New rows: append after the current max row number; new columns: append after the current max column number`;
    }

    _getDefaultTablesPromptJa() {
        return `═══ カスタムテーブルルール ═══
上記にユーザー定義テーブルがあります。「記入要件」に従ってデータを記入してください。
★ 形式：<horaetable:テーブル名> タグ内、1行に1セル → 行,列:内容
★★ 座標説明：第0行と第0列はヘッダーです。データは1,1から始まります。行番号=データ行インデックス、列番号=データ列インデックス
★★★ 記入ルール ★★★
  - 空セルで関連するプロット情報がある → 必ず記入！漏らさないこと！
  - 既存の内容に変更なし → 再記入しない
  - この行/列に関連するプロット情報がない → 空のまま
  - "(空)""-""なし"などのプレースホルダーを出力しないこと
  - 🔒マークの行/列は読み取り専用、内容を変更しないこと
  - 新しい行：現在の最大行番号の後に追加；新しい列：現在の最大列番号の後に追加`;
    }

    _getDefaultTablesPromptKo() {
        return `═══ 사용자 정의 테이블 규칙 ═══
위에 사용자 정의 테이블이 있습니다. "작성 요구사항"에 따라 데이터를 작성하세요.
★ 형식: <horaetable:테이블명> 태그 내, 한 줄에 하나의 셀 → 행,열:내용
★★ 좌표 설명: 0행과 0열은 헤더입니다. 데이터는 1,1부터 시작합니다. 행 번호 = 데이터 행 인덱스, 열 번호 = 데이터 열 인덱스
★★★ 작성 규칙 ★★★
  - 빈 셀에 관련 플롯 정보가 있음 → 반드시 작성! 누락 금지!
  - 기존 내용에 변경 없음 → 다시 쓰지 않음
  - 해당 행/열에 관련 플롯 정보 없음 → 비워둠
  - "(비어있음)" "-" "없음" 등의 플레이스홀더 출력 금지
  - 🔒 표시된 행/열은 읽기 전용, 내용 수정 금지
  - 새 행: 현재 최대 행 번호 뒤에 추가; 새 열: 현재 최대 열 번호 뒤에 추가`;
    }

    _getDefaultTablesPromptRu() {
        return `═══ Правила пользовательских таблиц ═══
Выше расположены пользовательские таблицы. Заполняйте данные согласно «Требованиям к заполнению».
★ Формат: внутри тегов <horaetable:название таблицы>, одна ячейка на строку → строка,столбец:содержимое
★★ Координаты: Строка 0 и столбец 0 — заголовки. Данные начинаются с 1,1. Номер строки = индекс строки данных, номер столбца = индекс столбца данных
★★★ Правила заполнения ★★★
  - Пустая ячейка с доступной информацией из сюжета → ОБЯЗАТЕЛЬНО заполнить! Не пропускать!
  - Существующее содержимое без изменений → не переписывать
  - Нет релевантной информации для этой строки/столбца → оставить пустой
  - НЕ выводить "(пусто)" "-" "нет" как заполнители
  - 🔒 отмеченные строки/столбцы — только для чтения, НЕ изменять их содержимое
  - Новые строки: добавлять после текущего максимального номера строки; новые столбцы: после максимального номера столбца`;
    }

    getDefaultLocationPrompt() {
        const lang = this._getAiOutputLang();
        if (lang === 'ja') return this._getDefaultLocationPromptJa();
        if (lang === 'ko') return this._getDefaultLocationPromptKo();
        if (lang === 'ru') return this._getDefaultLocationPromptRu();
        if (lang !== 'zh-CN' && lang !== 'zh-TW') return this._getDefaultLocationPromptEn();
        return `═══ 【场景记忆】触发条件 ═══
格式：scene_desc:位于…。该地点的固定物理特征描述（50-150字）
场景记忆记录地点的核心布局和永久性特征（建筑结构、固定家具、空间特点），用于保持跨回合的场景描写一致性。

【地点／位于 格式】★★★ 严格遵守层级规则 ★★★
  · 描述开头先写「位于」标明该地点相对于直接上级的方位，再写该地点自身的物理特征
  · 子级地点（含·分隔符的地名）：「位于」只写相对于父级建筑内部的方位（如哪一楼、哪个方向），绝对禁止包含父级的外部地理位置
  · 父级/顶级地点：「位于」才写外部地理位置（如哪个大陆、哪片森林旁）
  · 系统会自动同时发送父级描述给AI，子级无需也不应重复父级信息
    ✓ 无名酒馆·客房203 → scene_desc:位于2楼东侧。边间，采光佳，单人木床靠墙，窗户朝东
    ✓ 无名酒馆·大厅 → scene_desc:位于1楼。挑高木质空间，正中是长吧台，散落数张圆桌
    ✓ 无名酒馆 → scene_desc:位于OO大陆北方XX森林边上。两层木石结构，一楼大厅和吧台，二楼客房区
    ✗ 无名酒馆·客房203 → scene_desc:位于OO大陆北方XX森林边上的无名酒馆2楼…（❌ 子级禁止写父级的外部地理信息）
    ✗ 无名酒馆·大厅 → scene_desc:位于森林边上的无名酒馆1楼…（❌ 同上）
【地名规范】
  · 多级地点用·分隔：建筑·区域（如「无名酒馆·大厅」「皇宫·地牢」）
  · 同一地点必须始终使用与上方[场景|...]中完全一致的名称，禁止缩写或改写
  · 不同建筑的同名区域各自独立记录（如「无名酒馆·大厅」和「皇宫·大厅」是不同地点）
【何时写】
  ✦ 首次到达一个新地点 → 必须写scene_desc，描述该地点的固定物理特征
  ✦ 地点发生永久性物理变化（如被破坏、重新装修）→ 写更新后的scene_desc
【何时不写】
  ✗ 回到已记录的旧地点且无物理变化 → 不写
  ✗ 季节/天气/氛围变化 → 不写（这些是临时变化，不属于固定特征）
【描述规范】
  · 只写固定/永久性的物理特征：空间结构、建筑材质、固定家具、窗户朝向、标志性装饰
  · 不写临时性状态：当前光照、天气、人群、季节装饰、临时摆放的物品
  · 禁止照搬场景记忆原文到正文，将其作为背景参考，以当前时间/天气/光线/角色视角重新描写
  · 上方[场景记忆|...]是系统已记录的该地点特征，描写该场景时保持这些核心要素不变，同时根据时间/季节/剧情自由发挥变化细节`;
    }

    _getDefaultLocationPromptEn() {
        return `═══ [Scene Memory] Trigger Conditions ═══
Format: scene_desc:Located at... Fixed physical features of this location (120-300 chars)
Scene Memory records a location's core layout and permanent features (architectural structure, fixed furniture, spatial characteristics) to maintain consistent scene descriptions across turns.

[Location / "Located at" Format] ★★★ Strictly follow hierarchy rules ★★★
  · Start description with "Located at" to indicate this location's position relative to its parent, then describe its own physical features
  · Sub-locations (names containing · separator): "Located at" only describes position within the parent building (which floor, which direction). Absolutely NO external geographic info of the parent
  · Parent/top-level locations: "Located at" describes external geographic position (which continent, near which forest)
  · System automatically sends parent description to AI; sub-locations must NOT repeat parent info
    ✓ Nameless Tavern·Room 203 → scene_desc:Located on 2nd floor east side. Corner room, good lighting, single wooden bed against wall, east-facing window
    ✓ Nameless Tavern·Main Hall → scene_desc:Located on 1st floor. High-ceilinged wooden space, long bar counter in center, scattered round tables
    ✓ Nameless Tavern → scene_desc:Located at the edge of XX Forest in northern OO Continent. Two-story wood-and-stone structure, ground floor hall and bar, upper floor guest rooms
    ✗ Nameless Tavern·Room 203 → scene_desc:Located at the edge of XX Forest in northern OO Continent's Nameless Tavern 2nd floor... (❌ sub-location must NOT include parent's external geography)
[Location Name Rules]
  · Use · to separate multi-level locations: Building·Area (e.g. "Nameless Tavern·Main Hall" "Palace·Dungeon")
  · Same location must always use the exact same name as shown in [Scene|...] above; no abbreviations or rewording
  · Same-named areas in different buildings are recorded independently
[When to write]
  ✦ First arrival at a new location → MUST write scene_desc with fixed physical features
  ✦ Permanent physical change to location (destruction, renovation) → write updated scene_desc
[When NOT to write]
  ✗ Returning to a recorded location with no physical changes → do not write
  ✗ Season/weather/atmosphere changes → do not write (these are temporary, not fixed features)
[Description Rules]
  · Only write fixed/permanent physical features: spatial structure, building materials, fixed furniture, window orientation, landmark decorations
  · Do NOT write temporary states: current lighting, weather, crowds, seasonal decorations, temporarily placed items
  · Do NOT copy scene memory text verbatim into prose; use it as background reference and rewrite based on current time/weather/lighting/character perspective
  · [Scene Memory|...] above contains system-recorded features of this location; maintain these core elements while freely varying details based on time/season/plot`;
    }

    _getDefaultLocationPromptJa() {
        return `═══ 【シーン記憶】トリガー条件 ═══
形式：scene_desc:…に位置する。この場所の固定物理特徴の説明（120-300文字）
シーン記憶は場所の基本レイアウトと永続的特徴（建築構造、固定家具、空間特性）を記録し、ターン間で一貫したシーン描写を維持します。

【場所 / 「位置する」形式】★★★ 階層ルールを厳守 ★★★
  · 説明は「位置する」で始め、親に対するこの場所の位置を示し、その後この場所自体の物理特徴を記述
  · サブロケーション（·区切りを含む名前）：「位置する」は親建物内の位置のみ記述（何階、どの方向）。親の外部地理情報は絶対に含めない
  · 親/トップレベルの場所：「位置する」で外部地理的位置を記述（どの大陸、どの森の近く）
  · システムは自動的に親の説明をAIに送信；サブロケーションは親情報を繰り返してはならない
    ✓ 無名酒場·203号室 → scene_desc:2階東側に位置する。角部屋、採光良好、壁沿いのシングル木製ベッド、東向きの窓
    ✓ 無名酒場·大広間 → scene_desc:1階に位置する。高い天井の木造空間、中央に長いバーカウンター、散在する丸テーブル
    ✓ 無名酒場 → scene_desc:OO大陸北部XX森林の端に位置する。2階建て木石構造、1階はホールとバー、2階は客室
    ✗ 無名酒場·203号室 → scene_desc:OO大陸北部XX森林の端の無名酒場の2階に位置する…（❌ サブロケーションに親の外部地理情報を含めてはならない）
【地名規則】
  · 多階層の場所は·で区切る：建物·エリア（例「無名酒場·大広間」「宮殿·地下牢」）
  · 同じ場所は上記[シーン|...]に表示されている名前と完全に一致させる；省略や言い換え禁止
  · 異なる建物の同名エリアは各々独立して記録
【いつ書くか】
  ✦ 新しい場所に初めて到着 → 固定物理特徴のscene_descを必ず記述
  ✦ 場所に永久的な物理変化が発生（破壊、改装）→ 更新されたscene_descを記述
【いつ書かないか】
  ✗ 物理変化のない記録済みの場所に戻る → 書かない
  ✗ 季節/天気/雰囲気の変化 → 書かない（これらは一時的で固定特徴ではない）
【記述規則】
  · 固定/永久的な物理特徴のみ記述：空間構造、建材、固定家具、窓の向き、ランドマーク的装飾
  · 一時的な状態は書かない：現在の照明、天気、群衆、季節の装飾、一時的に置かれた物品
  · シーン記憶のテキストをそのまま本文にコピーしない；背景参考として使い、現在の時間/天気/照明/キャラクター視点で書き直す
  · 上記の[シーン記憶|...]はこの場所のシステム記録特徴；これらの核心要素を維持しながら、時間/季節/プロットに基づき変化の詳細を自由に表現`;
    }

    _getDefaultLocationPromptKo() {
        return `═══ 【장면 기억】트리거 조건 ═══
형식: scene_desc:…에 위치. 이 장소의 고정 물리적 특징 설명 (120-300자)
장면 기억은 장소의 핵심 레이아웃과 영구적 특징(건축 구조, 고정 가구, 공간 특성)을 기록하여 턴 간 일관된 장면 묘사를 유지합니다.

【장소 / "위치" 형식】★★★ 계층 규칙 엄격 준수 ★★★
  · 설명은 "위치"로 시작하여 상위에 대한 이 장소의 위치를 표시한 후, 이 장소 자체의 물리적 특징을 기술
  · 하위 장소(· 구분자를 포함하는 이름): "위치"는 상위 건물 내 위치만 기술(몇 층, 어느 방향). 상위의 외부 지리 정보는 절대 포함 금지
  · 상위/최상위 장소: "위치"에서 외부 지리적 위치 기술(어느 대륙, 어느 숲 근처)
  · 시스템이 자동으로 상위 설명을 AI에 전송; 하위 장소는 상위 정보를 반복해서는 안 됨
    ✓ 무명주점·203호실 → scene_desc:2층 동쪽에 위치. 코너룸, 채광 양호, 벽에 붙은 싱글 나무 침대, 동향 창문
    ✓ 무명주점·대홀 → scene_desc:1층에 위치. 높은 천장의 목조 공간, 중앙에 긴 바 카운터, 흩어진 원형 테이블
    ✓ 무명주점 → scene_desc:OO대륙 북부 XX숲 가장자리에 위치. 2층 목석 구조, 1층 홀과 바, 2층 객실
    ✗ 무명주점·203호실 → scene_desc:OO대륙 북부 XX숲 가장자리 무명주점 2층에 위치…(❌ 하위 장소에 상위의 외부 지리 정보 포함 금지)
【장소명 규칙】
  · 다중 레벨 장소는 ·로 구분: 건물·구역(예: "무명주점·대홀" "궁전·지하감옥")
  · 같은 장소는 위의 [장면|...]에 표시된 이름과 정확히 동일하게 사용; 축약이나 변경 금지
  · 다른 건물의 동명 구역은 각각 독립적으로 기록
【언제 쓰는가】
  ✦ 새로운 장소에 처음 도착 → 고정 물리적 특징의 scene_desc를 반드시 작성
  ✦ 장소에 영구적 물리적 변화 발생(파괴, 리모델링) → 업데이트된 scene_desc 작성
【언제 쓰지 않는가】
  ✗ 물리적 변화 없는 기록된 장소로 복귀 → 쓰지 않음
  ✗ 계절/날씨/분위기 변화 → 쓰지 않음(이는 일시적이며 고정 특징이 아님)
【묘사 규칙】
  · 고정/영구적 물리적 특징만 기술: 공간 구조, 건축 자재, 고정 가구, 창문 방향, 랜드마크 장식
  · 일시적 상태는 쓰지 않음: 현재 조명, 날씨, 인파, 계절 장식, 일시적으로 놓인 물품
  · 장면 기억 텍스트를 그대로 본문에 복사 금지; 배경 참조로 사용하고 현재 시간/날씨/조명/캐릭터 시점으로 다시 묘사
  · 위의 [장면 기억|...]은 이 장소의 시스템 기록 특징; 이러한 핵심 요소를 유지하면서 시간/계절/플롯에 따라 세부 사항을 자유롭게 변주`;
    }

    _getDefaultLocationPromptRu() {
        return `═══ [Память сцены] Условия срабатывания ═══
Формат: scene_desc:Расположен... Описание постоянных физических характеристик локации (120-300 символов)
Память сцены фиксирует базовую планировку и постоянные характеристики локации (архитектура, стационарная мебель, пространственные особенности) для поддержания согласованности описаний между ходами.

[Локация / формат «Расположен»] ★★★ Строго соблюдайте правила иерархии ★★★
  · Начинайте описание с «Расположен», указывая позицию относительно родительской локации, затем описывайте физические особенности самой локации
  · Подлокации (имена с разделителем ·): «Расположен» описывает только позицию внутри родительского здания (какой этаж, какое направление). Категорически запрещено включать внешнюю географию родителя
  · Родительские/верхнеуровневые локации: «Расположен» описывает внешнее географическое положение (какой континент, рядом с каким лесом)
  · Система автоматически отправляет описание родителя ИИ; подлокации НЕ должны повторять информацию родителя
    ✓ Безымянная Таверна·Комната 203 → scene_desc:Расположена на 2-м этаже, восточная сторона. Угловая комната, хорошее освещение, одноместная деревянная кровать у стены, окно на восток
    ✓ Безымянная Таверна·Главный зал → scene_desc:Расположен на 1-м этаже. Высокое деревянное пространство, длинная барная стойка в центре, разбросанные круглые столы
    ✓ Безымянная Таверна → scene_desc:Расположена на окраине леса XX на севере континента OO. Двухэтажная каменно-деревянная постройка, зал и бар на первом этаже, гостевые комнаты наверху
    ✗ Безымянная Таверна·Комната 203 → scene_desc:Расположена на окраине леса XX на севере континента OO в Безымянной Таверне на 2-м этаже… (❌ подлокация НЕ должна включать внешнюю географию родителя)
[Правила именования локаций]
  · Используйте · для разделения многоуровневых локаций: Здание·Зона (например, «Безымянная Таверна·Главный зал» «Дворец·Подземелье»)
  · Одна и та же локация должна всегда использовать точно такое же название, как показано в [Сцена|...] выше; без сокращений и перефразирования
  · Одноимённые зоны в разных зданиях записываются независимо
[Когда писать]
  ✦ Первое прибытие в новую локацию → ОБЯЗАТЕЛЬНО написать scene_desc с постоянными физическими характеристиками
  ✦ Постоянное физическое изменение локации (разрушение, ремонт) → написать обновлённый scene_desc
[Когда НЕ писать]
  ✗ Возвращение в записанную локацию без физических изменений → не писать
  ✗ Изменения сезона/погоды/атмосферы → не писать (это временные, а не постоянные характеристики)
[Правила описания]
  · Записывать только постоянные физические характеристики: пространственная структура, строительные материалы, стационарная мебель, ориентация окон, знаковые украшения
  · НЕ записывать временные состояния: текущее освещение, погоду, толпы, сезонные украшения, временно размещённые предметы
  · НЕ копировать текст памяти сцены дословно в прозу; использовать как фоновую справку и переписывать с учётом текущего времени/погоды/освещения/перспективы персонажа
  · [Память сцены|...] выше содержит записанные системой характеристики локации; сохраняйте эти ключевые элементы, свободно варьируя детали в зависимости от времени/сезона/сюжета`;
    }

    generateLocationMemoryPrompt() {
        if (!this.settings?.sendLocationMemory) return '';
        const custom = this.settings?.customLocationPrompt;
        if (custom) {
            const userName = this.context?.name1 || '主角';
            const charName = this.context?.name2 || '角色';
            return '\n' + custom.replace(/\{\{user\}\}/gi, userName).replace(/\{\{char\}\}/gi, charName);
        }
        return '\n' + this.getDefaultLocationPrompt();
    }

    generateCustomTablesPrompt() {
        const chat = this.getChat();
        const firstMsg = chat?.[0];
        const localTables = firstMsg?.horae_meta?.customTables || [];
        const resolvedCharacter = this._getResolvedCharacterTables();
        const resolvedGlobal = this._getResolvedGlobalTables();
        const allTables = [...resolvedGlobal, ...resolvedCharacter, ...localTables];
        if (allTables.length === 0) return '';

        let prompt = '\n' + (this.settings?.customTablesPrompt || this.getDefaultTablesPrompt());
        const lang = this._getAiOutputLang();
        const L = (zh, en, ja, ko, ru) => {
            if (lang === 'zh-CN' || lang === 'zh-TW') return zh;
            if (lang === 'ja') return ja;
            if (lang === 'ko') return ko;
            if (lang === 'ru') return ru;
            return en;
        };

        for (const table of allTables) {
            const tableName = table.name || L('自定义表格', 'Custom Table', 'カスタムテーブル', '사용자 정의 테이블', 'Пользовательская таблица');
            const rows = table.rows || 2;
            const cols = table.cols || 2;
            prompt += L(
                `\n★ 表格「${tableName}」尺寸：${rows - 1}行×${cols - 1}列（数据区行号1-${rows - 1}，列号1-${cols - 1}）`,
                `\n★ Table "${tableName}" size: ${rows - 1} rows × ${cols - 1} cols (data area: rows 1-${rows - 1}, cols 1-${cols - 1})`,
                `\n★ テーブル「${tableName}」サイズ：${rows - 1}行×${cols - 1}列（データ領域：行1-${rows - 1}、列1-${cols - 1}）`,
                `\n★ 테이블「${tableName}」크기: ${rows - 1}행×${cols - 1}열 (데이터 영역: 행 1-${rows - 1}, 열 1-${cols - 1})`,
                `\n★ Таблица «${tableName}» размер: ${rows - 1} строк × ${cols - 1} столбцов (область данных: строки 1-${rows - 1}, столбцы 1-${cols - 1})`
            );
            const sA = L('内容A', 'ContentA', '内容A', '내용A', 'СодержимоеA');
            const sB = L('内容B', 'ContentB', '内容B', '내용B', 'СодержимоеB');
            const sC = L('内容C', 'ContentC', '内容C', '내용C', 'СодержимоеC');
            const exLabel = L(
                '示例（填写空单元格或更新有变化的单元格）',
                'Example (fill empty cells or update changed cells)',
                '例（空のセルを埋めるか、変更のあるセルを更新）',
                '예시 (빈 셀을 채우거나 변경된 셀을 업데이트)',
                'Пример (заполните пустые ячейки или обновите изменённые)'
            );
            prompt += `\n${exLabel}：
<horaetable:${tableName}>
1,1:${sA}
1,2:${sB}
2,1:${sC}
</horaetable>`;
            break;
        }

        return prompt;
    }

    getDefaultRelationshipPrompt() {
        const userName = this.context?.name1 || '{{user}}';
        const lang = this._getAiOutputLang();
        if (lang === 'ja') return this._getDefaultRelationshipPromptJa(userName);
        if (lang === 'ko') return this._getDefaultRelationshipPromptKo(userName);
        if (lang === 'ru') return this._getDefaultRelationshipPromptRu(userName);
        if (lang !== 'zh-CN' && lang !== 'zh-TW') return this._getDefaultRelationshipPromptEn(userName);
        return `═══ 【关系网络】触发条件 ═══
格式：rel:角色A>角色B=关系类型|备注
系统会自动记录和显示角色间的关系网络，当角色间关系发生变化时输出。

【何时写】（满足任一条件才输出）
  ✦ 两个角色之间确立/定义了新关系 → rel:角色A>角色B=关系类型
  ✦ 已有关系发生变化（如从同事变成朋友）→ rel:角色A>角色B=新关系类型
  ✦ 关系中有重要细节需要备注 → 加|备注
【何时不写】
  ✗ 关系无变化 → 不写
  ✗ 已记录过的关系且无更新 → 不写

【规范】
  · 角色A和角色B都必须使用准确全名
  · 关系类型用简洁词描述：朋友、恋人、上下级、师徒、宿敌、合作伙伴等
  · 备注字段可选，记录关系的特殊细节
  · 包含${userName}的关系也要记录
  示例：
    rel:${userName}>沃尔=雇佣关系|${userName}经营酒馆，沃尔是常客
    rel:沃尔>艾拉=暗恋|沃尔对艾拉有好感但未表白
    rel:${userName}>艾拉=闺蜜`;
    }

    _getDefaultRelationshipPromptEn(userName) {
        return `═══ [Relationship Network] Trigger Conditions ═══
Format: rel:CharA>CharB=relationship type|notes
System automatically records and displays the relationship network between characters. Output when relationships change.

[When to write] (output only if any condition is met)
  ✦ Two characters establish/define a new relationship → rel:CharA>CharB=relationship type
  ✦ Existing relationship changes (colleague → friend) → rel:CharA>CharB=new relationship type
  ✦ Important details to note about the relationship → add |notes
[When NOT to write]
  ✗ Relationship unchanged → do not write
  ✗ Already recorded relationship with no update → do not write

[Rules]
  · CharA and CharB must both use accurate full names
  · Relationship type: use concise terms — friend, lover, superior-subordinate, mentor-student, rival, partner, etc.
  · Notes field is optional, for recording special details about the relationship
  · Relationships involving ${userName} must also be recorded
  Examples:
    rel:${userName}>Wolf=employer-client|${userName} runs a tavern, Wolf is a regular
    rel:Wolf>Ella=secret crush|Wolf has feelings for Ella but hasn't confessed
    rel:${userName}>Ella=best friends`;
    }

    _getDefaultRelationshipPromptJa(userName) {
        return `═══ 【関係ネットワーク】トリガー条件 ═══
形式：rel:キャラA>キャラB=関係タイプ|備考
システムがキャラクター間の関係ネットワークを自動的に記録・表示します。関係に変化があった時に出力。

【いつ書くか】（いずれかの条件を満たした場合のみ出力）
  ✦ 二人のキャラクター間で新しい関係が確立/定義された → rel:キャラA>キャラB=関係タイプ
  ✦ 既存の関係が変化（同僚 → 友人）→ rel:キャラA>キャラB=新しい関係タイプ
  ✦ 関係について重要な詳細を記録する必要がある → |備考を追加
【いつ書かないか】
  ✗ 関係に変化なし → 書かない
  ✗ 既に記録済みの関係で更新なし → 書かない

【ルール】
  · キャラAとキャラBは両方とも正確なフルネームを使用すること
  · 関係タイプ：簡潔な用語を使用 — 友人、恋人、上司-部下、師弟、ライバル、パートナーなど
  · 備考フィールドは任意、関係の特別な詳細を記録するため
  · ${userName}を含む関係も記録すること
  例：
    rel:${userName}>ウルフ=雇用関係|${userName}は酒場を経営、ウルフは常連客
    rel:ウルフ>エラ=密かな恋心|ウルフはエラに好意があるが告白していない
    rel:${userName}>エラ=親友`;
    }

    _getDefaultRelationshipPromptKo(userName) {
        return `═══ 【관계 네트워크】트리거 조건 ═══
형식: rel:캐릭터A>캐릭터B=관계 유형|비고
시스템이 캐릭터 간 관계 네트워크를 자동으로 기록하고 표시합니다. 관계 변화 시 출력.

【언제 쓰는가】(조건 중 하나라도 충족 시에만 출력)
  ✦ 두 캐릭터 사이에 새로운 관계가 확립/정의됨 → rel:캐릭터A>캐릭터B=관계 유형
  ✦ 기존 관계가 변화(동료 → 친구) → rel:캐릭터A>캐릭터B=새로운 관계 유형
  ✦ 관계에 대해 중요한 세부 사항을 기록할 필요가 있음 → |비고 추가
【언제 쓰지 않는가】
  ✗ 관계 변화 없음 → 쓰지 않음
  ✗ 이미 기록된 관계로 업데이트 없음 → 쓰지 않음

【규칙】
  · 캐릭터A와 캐릭터B 모두 정확한 전체 이름을 사용해야 함
  · 관계 유형: 간결한 용어 사용 — 친구, 연인, 상하관계, 사제, 라이벌, 파트너 등
  · 비고 필드는 선택사항, 관계의 특별한 세부 사항 기록용
  · ${userName}을 포함하는 관계도 기록해야 함
  예시:
    rel:${userName}>울프=고용 관계|${userName}은 주점을 운영, 울프는 단골
    rel:울프>엘라=짝사랑|울프는 엘라에게 호감이 있지만 고백하지 않음
    rel:${userName}>엘라=절친`;
    }

    _getDefaultRelationshipPromptRu(userName) {
        return `═══ [Сеть отношений] Условия срабатывания ═══
Формат: rel:ПерсонажА>ПерсонажБ=тип отношений|примечание
Система автоматически записывает и отображает сеть отношений между персонажами. Выводить при изменении отношений.

[Когда писать] (выводить только при выполнении любого условия)
  ✦ Между двумя персонажами установлены/определены новые отношения → rel:ПерсонажА>ПерсонажБ=тип отношений
  ✦ Существующие отношения изменились (коллега → друг) → rel:ПерсонажА>ПерсонажБ=новый тип отношений
  ✦ Важные детали об отношениях для записи → добавить |примечание
[Когда НЕ писать]
  ✗ Отношения не изменились → не писать
  ✗ Уже записанные отношения без обновлений → не писать

[Правила]
  · ПерсонажА и ПерсонажБ должны использовать точные полные имена
  · Тип отношений: краткие термины — друг, возлюбленный, начальник-подчинённый, наставник-ученик, соперник, партнёр и т.д.
  · Поле примечания необязательно, для записи особых деталей отношений
  · Отношения с участием ${userName} тоже должны быть записаны
  Примеры:
    rel:${userName}>Вольф=наниматель-клиент|${userName} управляет таверной, Вольф — постоянный посетитель
    rel:Вольф>Элла=тайная влюблённость|Вольф испытывает чувства к Элле, но не признался
    rel:${userName}>Элла=лучшие друзья`;
    }

    getDefaultMoodPrompt() {
        const lang = this._getAiOutputLang();
        if (lang === 'ja') return this._getDefaultMoodPromptJa();
        if (lang === 'ko') return this._getDefaultMoodPromptKo();
        if (lang === 'ru') return this._getDefaultMoodPromptRu();
        if (lang !== 'zh-CN' && lang !== 'zh-TW') return this._getDefaultMoodPromptEn();
        return `═══ 【情绪/心理状态追踪】触发条件 ═══
格式：mood:角色名=情绪状态（简洁词组，如"紧张/不安"、"开心/期待"、"愤怒"、"平静但警惕"）
系统会追踪在场角色的情绪变化，帮助保持角色心理状态的连贯性。

【何时写】（满足任一条件才输出）
  ✦ 角色情绪发生明显变化（如从平静变为愤怒）→ mood:角色名=新情绪
  ✦ 角色首次出场时有明显的情绪特征 → mood:角色名=当前情绪
【何时不写】
  ✗ 角色情绪无变化 → 不写
  ✗ 角色不在场 → 不写
【规范】
  · 情绪描述用1-4个词，用/分隔复合情绪
  · 只记录在场角色的情绪`;
    }

    _getDefaultMoodPromptEn() {
        return `═══ [Mood / Mental State Tracking] Trigger Conditions ═══
Format: mood:character name=emotional state (concise phrases, e.g. "nervous/uneasy", "happy/excited", "angry", "calm but wary")
System tracks emotional changes of present characters to maintain psychological consistency.

[When to write] (output only if any condition is met)
  ✦ Character's emotion changes significantly (calm → angry) → mood:character name=new emotion
  ✦ Character's first appearance with a notable emotional state → mood:character name=current emotion
[When NOT to write]
  ✗ Character's emotion unchanged → do not write
  ✗ Character not present → do not write
[Rules]
  · Use 1-4 words for emotion description, use / to separate compound emotions
  · Only record emotions of present characters`;
    }

    _getDefaultMoodPromptJa() {
        return `═══ 【感情/心理状態追跡】トリガー条件 ═══
形式：mood:キャラクター名=感情状態（簡潔なフレーズ、例：「緊張/不安」「嬉しい/期待」「怒り」「冷静だが警戒」）
システムは在場キャラクターの感情変化を追跡し、心理状態の一貫性を維持します。

【いつ書くか】（いずれかの条件を満たした場合のみ出力）
  ✦ キャラクターの感情が大きく変化（冷静 → 怒り）→ mood:キャラクター名=新しい感情
  ✦ キャラクターの初登場時に顕著な感情状態がある → mood:キャラクター名=現在の感情
【いつ書かないか】
  ✗ キャラクターの感情に変化なし → 書かない
  ✗ キャラクターが不在 → 書かない
【ルール】
  · 感情描写は1-4語で、/で複合感情を区切る
  · 在場キャラクターの感情のみ記録`;
    }

    _getDefaultMoodPromptKo() {
        return `═══ 【감정/심리 상태 추적】트리거 조건 ═══
형식: mood:캐릭터명=감정 상태(간결한 표현, 예: "긴장/불안", "기쁨/기대", "분노", "침착하지만 경계")
시스템이 현장 캐릭터의 감정 변화를 추적하여 심리 상태의 일관성을 유지합니다.

【언제 쓰는가】(조건 중 하나라도 충족 시에만 출력)
  ✦ 캐릭터의 감정이 크게 변화(침착 → 분노) → mood:캐릭터명=새로운 감정
  ✦ 캐릭터 첫 등장 시 뚜렷한 감정 상태가 있음 → mood:캐릭터명=현재 감정
【언제 쓰지 않는가】
  ✗ 캐릭터 감정 변화 없음 → 쓰지 않음
  ✗ 캐릭터가 현장에 없음 → 쓰지 않음
【규칙】
  · 감정 묘사는 1-4단어, /로 복합 감정 구분
  · 현장 캐릭터의 감정만 기록`;
    }

    _getDefaultMoodPromptRu() {
        return `═══ [Отслеживание настроения / психического состояния] Условия срабатывания ═══
Формат: mood:имя персонажа=эмоциональное состояние (краткие фразы, например: «нервозность/беспокойство», «радость/предвкушение», «гнев», «спокойствие, но настороженность»)
Система отслеживает эмоциональные изменения присутствующих персонажей для поддержания психологической согласованности.

[Когда писать] (выводить только при выполнении любого условия)
  ✦ Эмоция персонажа значительно изменилась (спокойствие → гнев) → mood:имя персонажа=новая эмоция
  ✦ Первое появление персонажа с заметным эмоциональным состоянием → mood:имя персонажа=текущая эмоция
[Когда НЕ писать]
  ✗ Эмоция персонажа не изменилась → не писать
  ✗ Персонаж отсутствует → не писать
[Правила]
  · Описание эмоции — 1-4 слова, используйте / для разделения сложных эмоций
  · Записывать эмоции только присутствующих персонажей`;
    }

    generateRelationshipPrompt() {
        if (!this.settings?.sendRelationships) return '';
        const custom = this.settings?.customRelationshipPrompt;
        if (custom) {
            const userName = this.context?.name1 || '主角';
            const charName = this.context?.name2 || '角色';
            return '\n' + custom.replace(/\{\{user\}\}/gi, userName).replace(/\{\{char\}\}/gi, charName);
        }
        return '\n' + this.getDefaultRelationshipPrompt();
    }

    _generateAntiParaphrasePrompt() {
        if (!this.settings?.antiParaphraseMode) return '';
        const lang = this._getAiOutputLang();
        const defaults = { 'zh-CN': '主角', 'zh-TW': '主角', 'ja': '主人公', 'ko': '주인공', 'ru': 'протагонист' };
        const userName = this.context?.name1 || (defaults[lang] || 'protagonist');
        if (lang === 'ja') return this._generateAntiParaphrasePromptJa(userName);
        if (lang === 'ko') return this._generateAntiParaphrasePromptKo(userName);
        if (lang === 'ru') return this._generateAntiParaphrasePromptRu(userName);
        if (lang !== 'zh-CN' && lang !== 'zh-TW') {
            return `
═══ Anti-Paraphrase Mode ═══
The user writes ${userName}'s actions/dialogue themselves in USER messages; you (AI) do NOT repeat ${userName}'s parts.
Therefore, when writing this turn's <horae> tags, you MUST also include events from "the USER message immediately preceding your reply":
  ✦ Items acquired/consumed in USER message → write corresponding item:/item-: lines
  ✦ Scene transitions in USER message → update location:
  ✦ NPC interactions/affection changes in USER message → update affection:
  ✦ Plot progression in USER message → include in <horaeevent> summary
  ✦ In short: this <horae> must cover ALL changes from BOTH "the previous USER message" AND "your current AI reply"
`;
        }
        return `
═══ 反转述模式（Anti-Paraphrase） ═══
当前用户使用反转述写法：${userName}的行动/对话由${userName}自行在USER消息中描写，你（AI）不再重复描述${userName}的部分。
因此，你在撰写本回合的<horae>标签时，必须把"紧接在你这条回复之前的那条USER消息"中发生的情节也一并纳入结算：
  ✦ USER消息中出现的物品获取/消耗 → 写入对应item:/item-:行
  ✦ USER消息中出现的场景转移 → 更新location:
  ✦ USER消息中出现的NPC互动/好感变化 → 更新affection:
  ✦ USER消息中出现的情节推进 → 在<horaeevent>中一并概括
  ✦ 总之：本条<horae>应同时覆盖"上一条USER消息"和"你本条AI回复"两部分的所有变化
`;
    }

    _generateAntiParaphrasePromptJa(userName) {
        return `
═══ 反転述モード（Anti-Paraphrase） ═══
ユーザーはUSERメッセージ内で${userName}の行動/台詞を自ら記述します。あなた（AI）は${userName}の部分を繰り返さないでください。
したがって、今回の<horae>タグを書く際、「あなたの返信の直前のUSERメッセージ」で発生した出来事も必ず含めてください：
  ✦ USERメッセージ内のアイテム取得/消費 → 対応するitem:/item-:行を記述
  ✦ USERメッセージ内のシーン移動 → location:を更新
  ✦ USERメッセージ内のNPC交流/好感度変化 → affection:を更新
  ✦ USERメッセージ内のプロット進行 → <horaeevent>に含めて要約
  ✦ 要するに：この<horae>は「前のUSERメッセージ」と「今回のAI返信」の両方のすべての変化を網羅すること
`;
    }

    _generateAntiParaphrasePromptKo(userName) {
        return `
═══ 반전술 모드 (Anti-Paraphrase) ═══
사용자는 USER 메시지에서 ${userName}의 행동/대사를 직접 작성합니다. 당신(AI)은 ${userName}의 부분을 반복하지 마세요.
따라서 이번 턴의 <horae> 태그를 작성할 때, "당신의 답변 바로 앞의 USER 메시지"에서 발생한 사건도 반드시 포함해야 합니다:
  ✦ USER 메시지에서의 아이템 획득/소모 → 해당 item:/item-: 행 작성
  ✦ USER 메시지에서의 장면 전환 → location: 업데이트
  ✦ USER 메시지에서의 NPC 상호작용/호감도 변화 → affection: 업데이트
  ✦ USER 메시지에서의 플롯 진행 → <horaeevent>에 포함하여 요약
  ✦ 요약: 이 <horae>는 "이전 USER 메시지"와 "이번 AI 답변" 양쪽의 모든 변화를 포괄해야 함
`;
    }

    _generateAntiParaphrasePromptRu(userName) {
        return `
═══ Режим Anti-Paraphrase ═══
Пользователь сам описывает действия/диалоги ${userName} в сообщениях USER; вы (ИИ) НЕ повторяете части ${userName}.
Поэтому при написании тегов <horae> для этого хода вы ОБЯЗАНЫ также включить события из «сообщения USER, непосредственно предшествующего вашему ответу»:
  ✦ Получение/расход предметов в сообщении USER → записать соответствующие строки item:/item-:
  ✦ Смена сцены в сообщении USER → обновить location:
  ✦ Взаимодействие с NPC/изменение расположения в сообщении USER → обновить affection:
  ✦ Развитие сюжета в сообщении USER → включить в сводку <horaeevent>
  ✦ Итого: этот <horae> должен охватывать ВСЕ изменения как из «предыдущего сообщения USER», так и из «вашего текущего ответа ИИ»
`;
    }

    generateMoodPrompt() {
        if (!this.settings?.sendMood) return '';
        const custom = this.settings?.customMoodPrompt;
        if (custom) {
            const userName = this.context?.name1 || '主角';
            const charName = this.context?.name2 || '角色';
            return '\n' + custom.replace(/\{\{user\}\}/gi, userName).replace(/\{\{char\}\}/gi, charName);
        }
        return '\n' + this.getDefaultMoodPrompt();
    }

    /** RPG 提示词（rpgMode 开启才注入） */
    generateRpgPrompt() {
        if (!this.settings?.rpgMode) return '';
        if (this.settings.customRpgPrompt) {
            const [userName, charName] = this._getDefaultNames();
            return '\n' + this.settings.customRpgPrompt
                .replace(/\{\{user\}\}/gi, userName)
                .replace(/\{\{char\}\}/gi, charName);
        }
        return '\n' + this.getDefaultRpgPrompt();
    }

    /** RPG 默认提示词 */
    getDefaultRpgPrompt() {
        const sendBars = this.settings?.sendRpgBars !== false;
        const sendSkills = this.settings?.sendRpgSkills !== false;
        const sendAttrs = this.settings?.sendRpgAttributes !== false;
        const sendEq = !!this.settings?.sendRpgEquipment;
        const sendRep = !!this.settings?.sendRpgReputation;
        const sendLvl = !!this.settings?.sendRpgLevel;
        const sendCur = !!this.settings?.sendRpgCurrency;
        const sendSh = !!this.settings?.sendRpgStronghold;
        if (!sendBars && !sendSkills && !sendAttrs && !sendEq && !sendRep && !sendLvl && !sendCur && !sendSh) return '';
        const lang = this._getAiOutputLang();
        const L = (zh, en, ja, ko, ru) => {
            if (lang === 'zh-CN' || lang === 'zh-TW') return zh;
            if (lang === 'ja') return ja;
            if (lang === 'ko') return ko;
            if (lang === 'ru') return ru;
            return en;
        };
        const userName = this.context?.name1 || L('主角', 'protagonist', '主人公', '주인공', 'протагонист');
        const uoBars = !!this.settings?.rpgBarsUserOnly;
        const uoSkills = !!this.settings?.rpgSkillsUserOnly;
        const uoAttrs = !!this.settings?.rpgAttrsUserOnly;
        const uoEq = !!this.settings?.rpgEquipmentUserOnly;
        const uoRep = !!this.settings?.rpgReputationUserOnly;
        const uoLvl = !!this.settings?.rpgLevelUserOnly;
        const uoCur = !!this.settings?.rpgCurrencyUserOnly;
        const anyUo = uoBars || uoSkills || uoAttrs || uoEq || uoRep || uoLvl || uoCur;
        const allUo = uoBars && uoSkills && uoAttrs && uoEq && uoRep && uoLvl && uoCur;
        const barCfg = this.settings?.rpgBarConfig || [
            { key: 'hp', name: 'HP' }, { key: 'mp', name: 'MP' }, { key: 'sp', name: 'SP' }
        ];
        const attrCfg = this.settings?.rpgAttributeConfig || [];
        const own = L('归属', 'owner', '所有者', '소유자', 'владелец');
        const commaSep = L('、', ', ', '、', ', ', ', ');
        const semiSep = L('；', '; ', '；', '; ', '; ');
        let p = L(
            `═══ 【RPG】 ═══\n你的回复末尾必须包含<horaerpg>标签。`,
            `═══ [RPG] ═══\nYour reply MUST include a <horaerpg> tag at the end.`,
            `═══ 【RPG】 ═══\nあなたの返信の末尾に必ず<horaerpg>タグを含めてください。`,
            `═══ 【RPG】 ═══\n답변 끝에 반드시 <horaerpg> 태그를 포함해야 합니다.`,
            `═══ [RPG] ═══\nВаш ответ ДОЛЖЕН включать тег <horaerpg> в конце.`
        );
        if (allUo) {
            p += L(
                `所有RPG数据仅追踪${userName}一人，格式中不含归属字段。禁止为NPC输出任何RPG行。\n`,
                `All RPG data tracks ${userName} only. Format has no owner field. Do NOT output RPG lines for NPCs.\n`,
                `すべてのRPGデータは${userName}のみを追跡します。フォーマットに所有者フィールドはありません。NPCのRPG行を出力しないでください。\n`,
                `모든 RPG 데이터는 ${userName}만 추적합니다. 형식에 소유자 필드가 없습니다. NPC의 RPG 행을 출력하지 마세요.\n`,
                `Все RPG-данные отслеживают только ${userName}. Формат не содержит поля владельца. НЕ выводите RPG-строки для NPC.\n`
            );
        } else if (anyUo) {
            p += L(
                `归属格式同NPC编号：N编号 全名，${userName}直接写名字不加N。部分模块仅追踪${userName}（以下会标注）。\n`,
                `Owner format follows NPC numbering: N## full name. ${userName} uses name directly without N. Some modules track ${userName} only (marked below).\n`,
                `所有者形式はNPC番号に従います：N番号 フルネーム。${userName}はNなしで直接名前を書きます。一部のモジュールは${userName}のみを追跡します（以下に記載）。\n`,
                `소유자 형식은 NPC 번호를 따릅니다: N번호 전체 이름. ${userName}은(는) N 없이 직접 이름을 씁니다. 일부 모듈은 ${userName}만 추적합니다(아래 표시).\n`,
                `Формат владельца следует нумерации NPC: N## полное имя. ${userName} пишется напрямую без N. Некоторые модули отслеживают только ${userName} (отмечено ниже).\n`
            );
        } else {
            p += L(
                `归属格式同NPC编号：N编号 全名，${userName}直接写名字不加N。\n`,
                `Owner format follows NPC numbering: N## full name. ${userName} uses name directly without N.\n`,
                `所有者形式はNPC番号に従います：N番号 フルネーム。${userName}はNなしで直接名前を書きます。\n`,
                `소유자 형식은 NPC 번호를 따릅니다: N번호 전체 이름. ${userName}은(는) N 없이 직접 이름을 씁니다.\n`,
                `Формат владельца следует нумерации NPC: N## полное имя. ${userName} пишется напрямую без N.\n`
            );
        }
        if (sendBars) {
            p += L(
                `\n【属性条——每回合必写，缺少=不合格！】\n`,
                `\n[Status Bars — required every turn, missing = fail!]\n`,
                `\n【ステータスバー——毎ターン必須、欠落＝不合格！】\n`,
                `\n【스테이터스 바 — 매 턴 필수, 누락 = 불합격!】\n`,
                `\n[Шкалы статуса — обязательны каждый ход, пропуск = провал!]\n`
            );
            if (uoBars) {
                p += L(
                    `仅输出${userName}的属性条和状态：\n`,
                    `Only output ${userName}'s status bars and status:\n`,
                    `${userName}のステータスバーとステータスのみを出力：\n`,
                    `${userName}의 스테이터스 바와 상태만 출력:\n`,
                    `Выводите только шкалы статуса и состояние ${userName}:\n`
                );
                for (const bar of barCfg) {
                    p += L(
                        `  ✅ ${bar.key}:当前/最大(${bar.name})  ← 首次必须标注显示名\n`,
                        `  ✅ ${bar.key}:current/max(${bar.name})  ← must label display name on first use\n`,
                        `  ✅ ${bar.key}:現在値/最大値(${bar.name})  ← 初回は表示名を必ず記載\n`,
                        `  ✅ ${bar.key}:현재/최대(${bar.name})  ← 첫 사용 시 표시 이름 필수\n`,
                        `  ✅ ${bar.key}:текущее/макс(${bar.name})  ← при первом использовании укажите отображаемое имя\n`
                    );
                }
                p += L(
                    `  ✅ status:效果1/效果2  ← 无异常写 正常\n`,
                    `  ✅ status:effect1/effect2  ← if no ailments write normal\n`,
                    `  ✅ status:効果1/効果2  ← 異常なしなら 正常 と記載\n`,
                    `  ✅ status:효과1/효과2  ← 이상 없으면 정상 기재\n`,
                    `  ✅ status:эффект1/эффект2  ← если нет отклонений, пишите нормально\n`
                );
            } else {
                p += L(
                    `必须为 characters: 中每个在场角色输出全部属性条和状态：\n`,
                    `MUST output ALL status bars and status for EVERY present character in characters: list:\n`,
                    `characters: リスト内のすべての登場キャラクターについて、全ステータスバーとステータスを出力する必要があります：\n`,
                    `characters: 목록의 모든 등장 캐릭터에 대해 전체 스테이터스 바와 상태를 출력해야 합니다:\n`,
                    `НЕОБХОДИМО вывести ВСЕ шкалы статуса и состояние для КАЖДОГО присутствующего персонажа в списке characters:\n`
                );
                for (const bar of barCfg) {
                    p += L(
                        `  ✅ ${bar.key}:归属=当前/最大(${bar.name})  ← 首次必须标注显示名\n`,
                        `  ✅ ${bar.key}:${own}=current/max(${bar.name})  ← must label display name on first use\n`,
                        `  ✅ ${bar.key}:${own}=現在値/最大値(${bar.name})  ← 初回は表示名を必ず記載\n`,
                        `  ✅ ${bar.key}:${own}=현재/최대(${bar.name})  ← 첫 사용 시 표시 이름 필수\n`,
                        `  ✅ ${bar.key}:${own}=текущее/макс(${bar.name})  ← при первом использовании укажите отображаемое имя\n`
                    );
                }
                p += L(
                    `  ✅ status:归属=效果1/效果2  ← 无异常写 =正常\n`,
                    `  ✅ status:${own}=effect1/effect2  ← if no ailments write =normal\n`,
                    `  ✅ status:${own}=効果1/効果2  ← 異常なしなら =正常 と記載\n`,
                    `  ✅ status:${own}=효과1/효과2  ← 이상 없으면 =정상 기재\n`,
                    `  ✅ status:${own}=эффект1/эффект2  ← если нет отклонений, пишите =нормально\n`
                );
            }
            p += L(`规则：\n`, `Rules:\n`, `ルール：\n`, `규칙:\n`, `Правила:\n`);
            p += L(
                `  - 战斗/受伤/施法/消耗 → 合理扣减；恢复/休息 → 合理回增\n`,
                `  - Combat/injury/casting/consumption → reasonable deduction; recovery/rest → reasonable increase\n`,
                `  - 戦闘/負傷/詠唱/消費 → 合理的に減少；回復/休息 → 合理的に増加\n`,
                `  - 전투/부상/시전/소모 → 합리적 감소; 회복/휴식 → 합리적 증가\n`,
                `  - Бой/ранение/заклинание/расход → обоснованное уменьшение; восстановление/отдых → обоснованное увеличение\n`
            );
            if (!uoBars) {
                p += L(
                    `  - 每个在场角色的每个属性条都必须写，漏写任何一人=不合格\n`,
                    `  - Every present character's every status bar MUST be written; missing anyone = fail\n`,
                    `  - 登場中の各キャラクターのすべてのステータスバーを書く必要があります；誰か一人でも漏れ＝不合格\n`,
                    `  - 등장 중인 모든 캐릭터의 모든 스테이터스 바를 작성해야 합니다; 누구 하나라도 누락 = 불합격\n`,
                    `  - Каждая шкала каждого присутствующего персонажа ДОЛЖНА быть записана; пропуск кого-либо = провал\n`
                );
            }
            p += L(
                `  - 即使本回合数值无变化，也必须写出当前值\n`,
                `  - Even if values didn't change this turn, MUST still write current values\n`,
                `  - 今回のターンで数値に変化がなくても、現在の値を必ず記載すること\n`,
                `  - 이번 턴에 수치 변화가 없더라도 현재 값을 반드시 기재할 것\n`,
                `  - Даже если значения не изменились в этом ходу, НЕОБХОДИМО записать текущие значения\n`
            );
        }
        if (sendAttrs && attrCfg.length > 0) {
            p += L(
                `\n【多维属性】仅首次登场或属性变化时写，无变化可省略\n`,
                `\n[Multi-Dimensional Attributes] Write only on first appearance or attribute change; skip if unchanged\n`,
                `\n【多次元属性】初登場時または属性変化時のみ記載、変化なしなら省略可\n`,
                `\n【다차원 속성】첫 등장 또는 속성 변화 시에만 기재, 변화 없으면 생략 가능\n`,
                `\n[Многомерные атрибуты] Записывайте только при первом появлении или изменении; пропускайте, если без изменений\n`
            );
            if (uoAttrs) {
                p += `  attr:${attrCfg.map(a => `${a.key}=value`).join('|')}\n`;
            } else {
                p += `  attr:${own}|${attrCfg.map(a => `${a.key}=value`).join('|')}\n`;
            }
            p += L(
                `  数值范围0-100。属性含义：${attrCfg.map(a => `${a.key}(${a.name})`).join('、')}\n`,
                `  Value range 0-100. Attribute meanings: ${attrCfg.map(a => `${a.key}(${a.name})`).join(', ')}\n`,
                `  数値範囲0-100。属性の意味：${attrCfg.map(a => `${a.key}(${a.name})`).join('、')}\n`,
                `  수치 범위 0-100. 속성 의미: ${attrCfg.map(a => `${a.key}(${a.name})`).join(', ')}\n`,
                `  Диапазон значений 0-100. Значения атрибутов: ${attrCfg.map(a => `${a.key}(${a.name})`).join(', ')}\n`
            );
        }
        if (sendSkills) {
            p += L(
                `\n【技能】仅习得/升级/失去时写，无变化可省略\n`,
                `\n[Skills] Write only when learned/upgraded/lost; skip if unchanged\n`,
                `\n【スキル】習得/レベルアップ/喪失時のみ記載、変化なしなら省略可\n`,
                `\n【스킬】습득/승급/상실 시에만 기재, 변화 없으면 생략 가능\n`,
                `\n[Навыки] Записывайте только при изучении/повышении/потере; пропускайте, если без изменений\n`
            );
            if (uoSkills) {
                p += L(
                    `  skill:技能名|等级|效果描述\n  skill-:技能名\n`,
                    `  skill:skill name|level|effect description\n  skill-:skill name\n`,
                    `  skill:スキル名|レベル|効果説明\n  skill-:スキル名\n`,
                    `  skill:스킬명|레벨|효과 설명\n  skill-:스킬명\n`,
                    `  skill:название навыка|уровень|описание эффекта\n  skill-:название навыка\n`
                );
            } else {
                p += L(
                    `  skill:归属|技能名|等级|效果描述\n  skill-:归属|技能名\n`,
                    `  skill:${own}|skill name|level|effect description\n  skill-:${own}|skill name\n`,
                    `  skill:${own}|スキル名|レベル|効果説明\n  skill-:${own}|スキル名\n`,
                    `  skill:${own}|스킬명|레벨|효과 설명\n  skill-:${own}|스킬명\n`,
                    `  skill:${own}|название навыка|уровень|описание эффекта\n  skill-:${own}|название навыка\n`
                );
            }
        }
        if (sendEq) {
            const eqCfg = this._getRpgEquipmentConfig();
            const perChar = eqCfg.perChar || {};
            const present = new Set(this.getLatestState()?.scene?.characters_present || []);
            const hasAnySlots = Object.values(perChar).some(c => c.slots?.length > 0);
            if (hasAnySlots) {
                p += L(
                    `\n【装备】角色穿戴/卸下装备时写，无变化可省略\n`,
                    `\n[Equipment] Write when character equips/unequips; skip if unchanged\n`,
                    `\n【装備】キャラクターが装備/解除した時に記載、変化なしなら省略可\n`,
                    `\n【장비】캐릭터가 장비 착용/해제 시 기재, 변화 없으면 생략 가능\n`,
                    `\n[Снаряжение] Записывайте при экипировке/снятии; пропускайте, если без изменений\n`
                );
                if (uoEq) {
                    p += L(
                        `  equip:格位名|装备名|属性1=值,属性2=值\n  unequip:格位名|装备名\n`,
                        `  equip:slot name|item name|stat1=value,stat2=value\n  unequip:slot name|item name\n`,
                        `  equip:スロット名|アイテム名|属性1=値,属性2=値\n  unequip:スロット名|アイテム名\n`,
                        `  equip:슬롯명|아이템명|속성1=값,속성2=값\n  unequip:슬롯명|아이템명\n`,
                        `  equip:слот|предмет|стат1=значение,стат2=значение\n  unequip:слот|предмет\n`
                    );
                    const userCfg = perChar[userName];
                    if (userCfg?.slots?.length) {
                        const slotNames = userCfg.slots.map(s => `${s.name}(×${s.maxCount ?? 1})`).join(commaSep);
                        p += L(`  格位: ${slotNames}\n`, `  Slots: ${slotNames}\n`, `  スロット: ${slotNames}\n`, `  슬롯: ${slotNames}\n`, `  Слоты: ${slotNames}\n`);
                    }
                } else {
                    p += L(
                        `  equip:归属|格位名|装备名|属性1=值,属性2=值\n  unequip:归属|格位名|装备名\n`,
                        `  equip:${own}|slot name|item name|stat1=value,stat2=value\n  unequip:${own}|slot name|item name\n`,
                        `  equip:${own}|スロット名|アイテム名|属性1=値,属性2=値\n  unequip:${own}|スロット名|アイテム名\n`,
                        `  equip:${own}|슬롯명|아이템명|속성1=값,속성2=값\n  unequip:${own}|슬롯명|아이템명\n`,
                        `  equip:${own}|слот|предмет|стат1=значение,стат2=значение\n  unequip:${own}|слот|предмет\n`
                    );
                    for (const [o, cfg] of Object.entries(perChar)) {
                        if (!cfg.slots?.length) continue;
                        if (present.size > 0 && !present.has(o)) continue;
                        const slotNames = cfg.slots.map(s => `${s.name}(×${s.maxCount ?? 1})`).join(commaSep);
                        p += L(`  ${o} 格位: ${slotNames}\n`, `  ${o} slots: ${slotNames}\n`, `  ${o} スロット: ${slotNames}\n`, `  ${o} 슬롯: ${slotNames}\n`, `  ${o} слоты: ${slotNames}\n`);
                    }
                }
                p += L(
                    `  ⚠ 每个角色只能使用其已注册的格位。属性值为整数。\n  ⚠ 普通衣物非赋魔或特殊材料不应有高属性值。\n`,
                    `  ⚠ Each character may only use their registered slots. Stat values must be integers.\n  ⚠ Normal clothing without enchantment or special materials should NOT have high stat values.\n`,
                    `  ⚠ 各キャラクターは登録済みのスロットのみ使用可能。属性値は整数であること。\n  ⚠ エンチャントや特殊素材のない普通の衣服には高い属性値を付けないこと。\n`,
                    `  ⚠ 각 캐릭터는 등록된 슬롯만 사용할 수 있습니다. 속성값은 정수여야 합니다.\n  ⚠ 마법 부여나 특수 재료가 없는 일반 의류에는 높은 속성값을 부여하지 마세요.\n`,
                    `  ⚠ Каждый персонаж может использовать только свои зарегистрированные слоты. Значения характеристик — целые числа.\n  ⚠ Обычная одежда без зачарования или особых материалов НЕ должна иметь высоких значений характеристик.\n`
                );
            }
        }
        if (sendRep) {
            const repConfig = this._getRpgReputationConfig();
            if (repConfig.categories.length > 0) {
                const catNames = repConfig.categories.map(c => c.name).join(commaSep);
                p += L(
                    `\n【声望】仅声望变化时写，无变化可省略\n`,
                    `\n[Reputation] Write only when reputation changes; skip if unchanged\n`,
                    `\n【評判】評判が変化した時のみ記載、変化なしなら省略可\n`,
                    `\n【평판】평판 변화 시에만 기재, 변화 없으면 생략 가능\n`,
                    `\n[Репутация] Записывайте только при изменении репутации; пропускайте, если без изменений\n`
                );
                if (uoRep) {
                    p += L(
                        `  rep:声望分类名=当前值\n`,
                        `  rep:category name=current value\n`,
                        `  rep:評判カテゴリ名=現在値\n`,
                        `  rep:평판 분류명=현재값\n`,
                        `  rep:категория=текущее значение\n`
                    );
                } else {
                    p += L(
                        `  rep:归属|声望分类名=当前值\n`,
                        `  rep:${own}|category name=current value\n`,
                        `  rep:${own}|評判カテゴリ名=現在値\n`,
                        `  rep:${own}|평판 분류명=현재값\n`,
                        `  rep:${own}|категория=текущее значение\n`
                    );
                }
                p += L(
                    `  已注册的声望分类: ${catNames}\n`,
                    `  Registered reputation categories: ${catNames}\n`,
                    `  登録済みの評判カテゴリ: ${catNames}\n`,
                    `  등록된 평판 분류: ${catNames}\n`,
                    `  Зарегистрированные категории репутации: ${catNames}\n`
                );
                p += L(
                    `  ⚠ 禁止创造新的声望分类。只允许使用上述已注册的分类名。\n`,
                    `  ⚠ Do NOT create new reputation categories. Only use the registered names above.\n`,
                    `  ⚠ 新しい評判カテゴリを作成しないでください。上記の登録済みカテゴリ名のみ使用可。\n`,
                    `  ⚠ 새로운 평판 분류를 만들지 마세요. 위에 등록된 분류명만 사용하세요.\n`,
                    `  ⚠ НЕ создавайте новые категории репутации. Используйте только зарегистрированные названия выше.\n`
                );
            }
        }
        if (sendLvl) {
            p += L(
                `\n【等级与经验值】仅升级/降级或经验变化时写，无变化可省略\n`,
                `\n[Level & XP] Write only on level-up/down or XP change; skip if unchanged\n`,
                `\n【レベルと経験値】レベルアップ/ダウンまたは経験値変化時のみ記載、変化なしなら省略可\n`,
                `\n【레벨과 경험치】레벨 업/다운 또는 경험치 변화 시에만 기재, 변화 없으면 생략 가능\n`,
                `\n[Уровень и опыт] Записывайте только при повышении/понижении уровня или изменении опыта; пропускайте, если без изменений\n`
            );
            if (uoLvl) {
                p += L(
                    `  level:等级数值\n  xp:当前经验/升级所需\n`,
                    `  level:level number\n  xp:current XP/needed for level-up\n`,
                    `  level:レベル数値\n  xp:現在の経験値/レベルアップに必要な値\n`,
                    `  level:레벨 수치\n  xp:현재 경험치/레벨업 필요치\n`,
                    `  level:число уровня\n  xp:текущий опыт/необходимо для повышения\n`
                );
            } else {
                p += L(
                    `  level:归属=等级数值\n  xp:归属=当前经验/升级所需\n`,
                    `  level:${own}=level number\n  xp:${own}=current XP/needed for level-up\n`,
                    `  level:${own}=レベル数値\n  xp:${own}=現在の経験値/レベルアップに必要な値\n`,
                    `  level:${own}=레벨 수치\n  xp:${own}=현재 경험치/레벨업 필요치\n`,
                    `  level:${own}=число уровня\n  xp:${own}=текущий опыт/необходимо для повышения\n`
                );
            }
            p += L(`  经验值获取参考：\n`, `  XP gain reference:\n`, `  経験値獲得の参考：\n`, `  경험치 획득 참고:\n`, `  Справка по получению опыта:\n`);
            p += L(
                `  - 与角色等级相近或更强的挑战：获得较多经验(10~50+)\n  - 等级差 ≥10 的低级挑战：仅得 1 点经验\n  - 日常活动/对话/探索：少量经验(1~5)\n  - 升级所需经验随等级递增：建议 升级所需 = 等级 × 100\n`,
                `  - Challenge near or above character level: more XP (10~50+)\n  - Level gap ≥10 trivial challenge: only 1 XP\n  - Daily activities/dialogue/exploration: small XP (1~5)\n  - XP needed increases with level: suggested formula = level × 100\n`,
                `  - キャラクターレベルに近いまたはそれ以上の挑戦：多くの経験値(10~50+)\n  - レベル差≥10の簡単な挑戦：1経験値のみ\n  - 日常活動/会話/探索：少量の経験値(1~5)\n  - レベルアップに必要な経験値はレベルに応じて増加：推奨式 = レベル × 100\n`,
                `  - 캐릭터 레벨에 가깝거나 더 강한 도전: 많은 경험치(10~50+)\n  - 레벨 차이 ≥10인 사소한 도전: 1 경험치만\n  - 일상 활동/대화/탐험: 소량의 경험치(1~5)\n  - 레벨업 필요 경험치는 레벨에 따라 증가: 권장 공식 = 레벨 × 100\n`,
                `  - Испытание близкое к уровню персонажа или выше: больше опыта (10~50+)\n  - Разница уровней ≥10, тривиальное испытание: только 1 очко опыта\n  - Повседневные действия/диалог/исследование: немного опыта (1~5)\n  - Необходимый опыт растёт с уровнем: рекомендуемая формула = уровень × 100\n`
            );
        }
        if (sendCur) {
            const curConfig = this._getRpgCurrencyConfig();
            if (curConfig.denominations.length > 0) {
                const denomNames = curConfig.denominations.map(d => d.name).join(commaSep);
                p += L(
                    `\n【货币——发生交易/拾取/消费时必写！】\n`,
                    `\n[Currency — MUST write on any trade/pickup/spending!]\n`,
                    `\n【通貨——取引/拾得/消費が発生した時は必ず記載！】\n`,
                    `\n【화폐 — 거래/획득/소비 발생 시 필수 기재!】\n`,
                    `\n[Валюта — ОБЯЗАТЕЛЬНО записывать при любой сделке/подборе/трате!]\n`
                );
                if (uoCur) {
                    p += L(`格式: currency:币名=±变化量\n`, `Format: currency:denomination=±amount\n`, `形式: currency:通貨名=±変化量\n`, `형식: currency:화폐명=±변화량\n`, `Формат: currency:валюта=±сумма\n`);
                    p += L(`示例:\n`, `Examples:\n`, `例：\n`, `예시:\n`, `Примеры:\n`);
                    p += `  currency:${curConfig.denominations[0].name}=+10\n  currency:${curConfig.denominations[0].name}=-3\n`;
                    if (curConfig.denominations.length > 1) p += `  currency:${curConfig.denominations[1].name}=+50\n`;
                    p += L(
                        `也可写绝对值: currency:币名=数量\n`,
                        `Absolute value also OK: currency:denomination=amount\n`,
                        `絶対値も可: currency:通貨名=数量\n`,
                        `절대값도 가능: currency:화폐명=수량\n`,
                        `Абсолютное значение тоже допустимо: currency:валюта=количество\n`
                    );
                } else {
                    p += L(`格式: currency:归属|币名=±变化量\n`, `Format: currency:${own}|denomination=±amount\n`, `形式: currency:${own}|通貨名=±変化量\n`, `형식: currency:${own}|화폐명=±변화량\n`, `Формат: currency:${own}|валюта=±сумма\n`);
                    p += L(`示例:\n`, `Examples:\n`, `例：\n`, `예시:\n`, `Примеры:\n`);
                    p += `  currency:${userName}|${curConfig.denominations[0].name}=+10\n  currency:${userName}|${curConfig.denominations[0].name}=-3\n`;
                    if (curConfig.denominations.length > 1) p += `  currency:${userName}|${curConfig.denominations[1].name}=+50\n`;
                    p += L(
                        `也可写绝对值: currency:归属|币名=数量\n`,
                        `Absolute value also OK: currency:${own}|denomination=amount\n`,
                        `絶対値も可: currency:${own}|通貨名=数量\n`,
                        `절대값도 가능: currency:${own}|화폐명=수량\n`,
                        `Абсолютное значение тоже допустимо: currency:${own}|валюта=количество\n`
                    );
                }
                p += L(`已注册币种: ${denomNames}\n`, `Registered denominations: ${denomNames}\n`, `登録済み通貨: ${denomNames}\n`, `등록된 화폐: ${denomNames}\n`, `Зарегистрированные валюты: ${denomNames}\n`);
                p += L(
                    `⚠ 禁止使用未注册的币种名。任何涉及金钱的行为（买卖/拾取/奖赏/偷窃）都必须写 currency 行。\n`,
                    `⚠ Do NOT use unregistered denomination names. Any money-related action (buy/sell/pickup/reward/theft) MUST include a currency line.\n`,
                    `⚠ 未登録の通貨名を使用しないでください。金銭に関わるすべての行動（売買/拾得/報酬/窃盗）にはcurrency行を必ず含めること。\n`,
                    `⚠ 등록되지 않은 화폐명을 사용하지 마세요. 금전 관련 모든 행동(매매/획득/보상/절도)에는 반드시 currency 행을 포함해야 합니다.\n`,
                    `⚠ НЕ используйте незарегистрированные названия валют. Любое действие с деньгами (покупка/продажа/подбор/награда/кража) ДОЛЖНО содержать строку currency.\n`
                );
            }
        }
        if (!!this.settings?.sendRpgStronghold) {
            const rpg = this.getChat()?.[0]?.horae_meta?.rpg;
            const nodes = rpg?.strongholds || [];
            p += L(
                `\n【据点/基地】据点状态变化时写（升级/建造/损毁/描述变更），无变化可省略。已有据点必须始终使用与下方「当前据点」完全一致的名称，禁止对已有名称做缩写/改写/加前缀变体\n`,
                `\n[Strongholds] Write when stronghold status changes (upgrade/build/destroy/description update); skip if unchanged. Existing strongholds MUST always use the exact same name as listed in "Current strongholds" below — no abbreviations, rewrites, or prefixed variants of existing names\n`,
                `\n【拠点/基地】拠点の状態が変化した時に記載（アップグレード/建設/破壊/説明更新）、変化なしなら省略可。既存の拠点名は下記「現在の拠点」と完全一致させる — 省略・言い換え・接頭辞変形は禁止\n`,
                `\n【거점/기지】거점 상태 변화 시 기재(업그레이드/건설/파괴/설명 변경), 변화 없으면 생략 가능. 기존 거점은 아래 '현재 거점'에 표시된 이름과 정확히 일치해야 함 — 줄임/변형/접두사 변형 금지\n`,
                `\n[Крепости] Записывайте при изменении статуса крепости (улучшение/строительство/разрушение/обновление описания); пропускайте, если без изменений. Существующие крепости ДОЛЖНЫ использовать точно такие же названия, как в списке ниже — сокращения, переименования и варианты с префиксами запрещены\n`
            );
            p += L(
                `格式: base:据点路径=等级 或 base:据点路径|desc=描述\n路径用 > 分隔层级\n`,
                `Format: base:stronghold path=level or base:stronghold path|desc=description\nUse > to separate hierarchy levels\n`,
                `形式: base:拠点パス=レベル または base:拠点パス|desc=説明\nパスは > で階層を区切る\n`,
                `형식: base:거점 경로=레벨 또는 base:거점 경로|desc=설명\n경로는 > 로 계층 구분\n`,
                `Формат: base:путь крепости=уровень или base:путь крепости|desc=описание\nИспользуйте > для разделения уровней иерархии\n`
            );
            p += L(`示例:\n`, `Examples:\n`, `例：\n`, `예시:\n`, `Примеры:\n`);
            p += L(
                `  base:主角庄园=3\n  base:主角庄园>锻造区>锻造炉=2\n  base:主角庄园|desc=坐落于河谷的石砌庄园，配有围墙和瞭望塔\n`,
                `  base:Hero's Manor=3\n  base:Hero's Manor>Forge Area>Furnace=2\n  base:Hero's Manor|desc=Stone manor in a river valley with walls and watchtower\n`,
                `  base:主人公の館=3\n  base:主人公の館>鍛冶場>溶鉱炉=2\n  base:主人公の館|desc=川の谷にある石造りの館、壁と見張り塔付き\n`,
                `  base:주인공의 저택=3\n  base:주인공의 저택>대장간>용광로=2\n  base:주인공의 저택|desc=성벽과 망루가 있는 강 계곡의 석조 저택\n`,
                `  base:Поместье героя=3\n  base:Поместье героя>Кузница>Печь=2\n  base:Поместье героя|desc=Каменное поместье в речной долине со стенами и сторожевой башней\n`
            );
            if (nodes.length > 0) {
                const rootNodes = nodes.filter(n => !n.parent);
                const summary = rootNodes.map(r => {
                    const kids = nodes.filter(n => n.parent === r.id);
                    const kidStr = kids.length > 0 ? `(${kids.map(k => k.name).join(commaSep)})` : '';
                    return `${r.name}${r.level != null ? ' Lv.' + r.level : ''}${kidStr}`;
                }).join(semiSep);
                p += L(`当前据点: ${summary}\n`, `Current strongholds: ${summary}\n`, `現在の拠点: ${summary}\n`, `현재 거점: ${summary}\n`, `Текущие крепости: ${summary}\n`);
            }
        }
        return p;
    }

    /** 获取当前对话的装备配置 */
    _getRpgEquipmentConfig() {
        const rpg = this.getChat()?.[0]?.horae_meta?.rpg;
        return rpg?.equipmentConfig || { locked: false, perChar: {} };
    }

    /** 获取当前对话的声望配置 */
    _getRpgReputationConfig() {
        const rpg = this.getChat()?.[0]?.horae_meta?.rpg;
        return rpg?.reputationConfig || { categories: [], _deletedCategories: [] };
    }

    /** 获取当前对话的货币配置 */
    _getRpgCurrencyConfig() {
        const rpg = this.getChat()?.[0]?.horae_meta?.rpg;
        return rpg?.currencyConfig || { denominations: [] };
    }

    /** 动态生成必须包含的标签提醒（RPG 开启时追加 <horaerpg>） */
    _generateMustTagsReminder() {
        const tags = ['<horae>...</horae>', '<horaeevent>...</horaeevent>'];
        const rpgActive = this.settings?.rpgMode &&
            (this.settings.sendRpgBars !== false || this.settings.sendRpgSkills !== false ||
             this.settings.sendRpgAttributes !== false || !!this.settings.sendRpgReputation ||
             !!this.settings.sendRpgEquipment || !!this.settings.sendRpgLevel || !!this.settings.sendRpgCurrency ||
             !!this.settings.sendRpgStronghold);
        if (rpgActive) tags.push('<horaerpg>...</horaerpg>');
        const lang = this._getAiOutputLang();
        const joined = tags.join(' and ');
        if (lang === 'zh-CN' || lang === 'zh-TW') {
            const count = tags.length === 2 ? '两个' : `${tags.length}个`;
            return `你的回复末尾必须包含 ${tags.join(' 和 ')} ${count}标签。\n缺少任何一个标签=不合格。`;
        }
        if (lang === 'ja') {
            return `あなたの返信の末尾には必ず ${joined}（合計${tags.length}個のタグ）を含めてください。\nいずれかのタグが欠けている＝不合格。`;
        }
        if (lang === 'ko') {
            return `당신의 답변 끝에 반드시 ${joined} (총 ${tags.length}개 태그)를 포함해야 합니다.\n태그가 하나라도 빠지면 = 불합격.`;
        }
        if (lang === 'ru') {
            return `Ваш ответ ДОЛЖЕН заканчиваться ${joined} (всего ${tags.length} тегов).\nОтсутствие любого тега = недопустимо.`;
        }
        return `Your reply MUST end with ${joined} (${tags.length} tags total).\nMissing any tag = unacceptable.`;
    }

    /** 宽松正则解析（不需要标签包裹） */
    parseLooseFormat(message) {
        const result = {
            timestamp: {},
            costumes: {},
            items: {},
            deletedItems: [],
            events: [],  // 支持多个事件
            affection: {},
            npcs: {},
            scene: {},
            agenda: [],   // 待办事项
            deletedAgenda: []  // 已完成的待办事项
        };

        let hasAnyData = false;

        const patterns = {
            time: /time[:：]\s*(.+?)(?:\n|$)/gi,
            location: /location[:：]\s*(.+?)(?:\n|$)/gi,
            atmosphere: /atmosphere[:：]\s*(.+?)(?:\n|$)/gi,
            characters: /characters[:：]\s*(.+?)(?:\n|$)/gi,
            costume: /costume[:：]\s*(.+?)(?:\n|$)/gi,
            item: /item(!{0,2})[:：]\s*(.+?)(?:\n|$)/gi,
            itemDelete: /item-[:：]\s*(.+?)(?:\n|$)/gi,
            event: /event[:：]\s*(.+?)(?:\n|$)/gi,
            affection: /affection[:：]\s*(.+?)(?:\n|$)/gi,
            npc: /npc[:：]\s*(.+?)(?:\n|$)/gi,
            agendaDelete: /agenda-[:：]\s*(.+?)(?:\n|$)/gi,
            agenda: /agenda[:：]\s*(.+?)(?:\n|$)/gi
        };

        // time
        let match;
        while ((match = patterns.time.exec(message)) !== null) {
            const timeStr = match[1].trim();
            const clockMatch = timeStr.match(/\b(\d{1,2}:\d{2})\s*$/);
            if (clockMatch) {
                result.timestamp.story_time = clockMatch[1];
                result.timestamp.story_date = timeStr.substring(0, timeStr.lastIndexOf(clockMatch[1])).trim();
            } else {
                result.timestamp.story_date = timeStr;
                result.timestamp.story_time = '';
            }
            hasAnyData = true;
        }

        // location
        while ((match = patterns.location.exec(message)) !== null) {
            result.scene.location = match[1].trim();
            hasAnyData = true;
        }

        // atmosphere
        while ((match = patterns.atmosphere.exec(message)) !== null) {
            result.scene.atmosphere = match[1].trim();
            hasAnyData = true;
        }

        // characters
        while ((match = patterns.characters.exec(message)) !== null) {
            result.scene.characters_present = match[1].trim().split(/[,，]/).map(c => c.trim()).filter(Boolean);
            hasAnyData = true;
        }

        // costume
        while ((match = patterns.costume.exec(message)) !== null) {
            const costumeStr = match[1].trim();
            const eqIndex = costumeStr.indexOf('=');
            if (eqIndex > 0) {
                const char = costumeStr.substring(0, eqIndex).trim();
                const costume = costumeStr.substring(eqIndex + 1).trim();
                result.costumes[char] = costume;
                hasAnyData = true;
            }
        }

        // item
        while ((match = patterns.item.exec(message)) !== null) {
            const exclamations = match[1] || '';
            const itemStr = match[2].trim();
            let importance = '';  // 一般用空字符串
            if (exclamations === '!!') importance = '!!';  // 关键
            else if (exclamations === '!') importance = '!';  // 重要
            
            const eqIndex = itemStr.indexOf('=');
            if (eqIndex > 0) {
                let itemNamePart = itemStr.substring(0, eqIndex).trim();
                const rest = itemStr.substring(eqIndex + 1).trim();
                
                let icon = null;
                let itemName = itemNamePart;
                const emojiMatch = itemNamePart.match(/^([\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}])/u);
                if (emojiMatch) {
                    icon = emojiMatch[1];
                    itemName = itemNamePart.substring(icon.length).trim();
                }
                
                let description = undefined;  // undefined = 没有描述字段，合并时不覆盖原有描述
                const pipeIdx = itemName.indexOf('|');
                if (pipeIdx > 0) {
                    const descText = itemName.substring(pipeIdx + 1).trim();
                    if (descText) description = descText;  // 只有非空才设置
                    itemName = itemName.substring(0, pipeIdx).trim();
                }
                
                // 去掉无意义的数量标记
                itemName = itemName.replace(/[\(（]1[\)）]$/, '').trim();
                itemName = itemName.replace(new RegExp(`[\\(（]1[${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                itemName = itemName.replace(new RegExp(`[\\(（][${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                
                const atIndex = rest.indexOf('@');
                const itemInfo = {
                    icon: icon,
                    importance: importance,
                    holder: atIndex >= 0 ? (rest.substring(0, atIndex).trim() || null) : (rest || null),
                    location: atIndex >= 0 ? (rest.substring(atIndex + 1).trim() || '') : ''
                };
                if (description !== undefined) itemInfo.description = description;
                result.items[itemName] = itemInfo;
                hasAnyData = true;
            }
        }

        // item-
        while ((match = patterns.itemDelete.exec(message)) !== null) {
            const itemName = match[1].trim().replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, '').trim();
            if (itemName) {
                result.deletedItems.push(itemName);
                hasAnyData = true;
            }
        }

        // event
        while ((match = patterns.event.exec(message)) !== null) {
            const eventStr = match[1].trim();
            const parts = eventStr.split('|');
            if (parts.length >= 2) {
                const levelRaw = parts[0].trim();
                const summary = parts.slice(1).join('|').trim();
                
                let level = '一般';
                if (levelRaw === '关键' || levelRaw === '關鍵' || levelRaw.toLowerCase() === 'critical') {
                    level = '关键';
                } else if (levelRaw === '重要' || levelRaw.toLowerCase() === 'important') {
                    level = '重要';
                }
                
                result.events.push({
                    is_important: level === '重要' || level === '关键',
                    level: level,
                    summary: summary
                });
                hasAnyData = true;
            }
        }

        // affection
        while ((match = patterns.affection.exec(message)) !== null) {
            const affStr = match[1].trim();
            // 绝对值格式
            const absMatch = affStr.match(/^(.+?)=\s*([+\-]?\d+\.?\d*)/);
            if (absMatch) {
                result.affection[absMatch[1].trim()] = { type: 'absolute', value: parseFloat(absMatch[2]) };
                hasAnyData = true;
            } else {
                // 相对值格式 name+/-数值（无=号）
                const relMatch = affStr.match(/^(.+?)([+\-]\d+\.?\d*)/);
                if (relMatch) {
                    result.affection[relMatch[1].trim()] = { type: 'relative', value: relMatch[2] };
                    hasAnyData = true;
                }
            }
        }

        // npc
        while ((match = patterns.npc.exec(message)) !== null) {
            const npcStr = match[1].trim();
            const npcInfo = this._parseNpcFields(npcStr);
            const name = npcInfo._name;
            delete npcInfo._name;
            
            if (name) {
                npcInfo.last_seen = new Date().toISOString();
                result.npcs[name] = npcInfo;
                hasAnyData = true;
            }
        }

        // agenda-:（须在 agenda 之前解析）
        while ((match = patterns.agendaDelete.exec(message)) !== null) {
            const delStr = match[1].trim();
            if (delStr) {
                const pipeIdx = delStr.indexOf('|');
                const text = pipeIdx > 0 ? delStr.substring(pipeIdx + 1).trim() : delStr;
                if (text) {
                    result.deletedAgenda.push(text);
                    hasAnyData = true;
                }
            }
        }

        // agenda
        while ((match = patterns.agenda.exec(message)) !== null) {
            const agendaStr = match[1].trim();
            const pipeIdx = agendaStr.indexOf('|');
            let dateStr = '', text = '';
            if (pipeIdx > 0) {
                dateStr = agendaStr.substring(0, pipeIdx).trim();
                text = agendaStr.substring(pipeIdx + 1).trim();
            } else {
                text = agendaStr;
            }
            if (text) {
                const doneMatch = text.match(/[\(（](完成|已完成|done|finished|completed|失效|取消|已取消)[\)）]\s*$/i);
                if (doneMatch) {
                    const cleanText = text.substring(0, text.length - doneMatch[0].length).trim();
                    if (cleanText) { result.deletedAgenda.push(cleanText); hasAnyData = true; }
                } else {
                    result.agenda.push({ date: dateStr, text, source: 'ai', done: false });
                    hasAnyData = true;
                }
            }
        }

        // 表格更新
        const tableMatches = [...message.matchAll(/<horaetable[:：]\s*(.+?)>([\s\S]*?)<\/horaetable(?:[:：][^>]*)?>/gi)];
        if (tableMatches.length > 0) {
            result.tableUpdates = [];
            for (const tm of tableMatches) {
                const tableName = tm[1].trim();
                const tableContent = tm[2].trim();
                const updates = this._parseTableCellEntries(tableContent);
                
                if (Object.keys(updates).length > 0) {
                    result.tableUpdates.push({ name: tableName, updates });
                    hasAnyData = true;
                }
            }
        }

        return hasAnyData ? result : null;
    }
}

// 导出单例
export const horaeManager = new HoraeManager();
