"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadCustomStrings = loadCustomStrings;
const fs_1 = require("fs");
const i18next_1 = __importStar(require("i18next"));
const en = __importStar(require("./locales/en.json"));
const ja = __importStar(require("./locales/ja.json"));
const th = __importStar(require("./locales/th.json"));
const ur = __importStar(require("./locales/ur.json"));
const zhCn = __importStar(require("./locales/zh-cn.json"));
const defaultResources = {
    en: {
        translation: en,
    },
    "zh-cn": {
        translation: zhCn,
    },
    th: {
        translation: th,
    },
    ja: {
        translation: ja,
    },
    ur: {
        translation: ur,
    },
};
function loadCustomStrings(filePath) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Read custom strings from file path only
            const fileContent = yield fs_1.promises.readFile(filePath, "utf8");
            const customStringsData = JSON.parse(fileContent);
            // User-provided strings override all languages.
            Object.keys(defaultResources).forEach((locale) => {
                i18next_1.default.addResourceBundle(locale, "translation", customStringsData);
            });
        }
        catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
                throw new Error(`Custom strings file not found: ${filePath}\nPlease ensure the file exists and is readable.`);
            }
            else if (error instanceof SyntaxError) {
                throw new Error(`Invalid JSON in custom strings file: ${filePath}\n${error.message}`);
            }
            else {
                throw new Error(`Failed to load custom strings from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    });
}
(0, i18next_1.init)({
    lng: "en",
    fallbackLng: "en", // language to use if translations in user language are not available.
    returnNull: false,
    lowerCaseLng: true,
    debug: process.env.NODE_ENV === "development",
    resources: defaultResources,
});
exports.default = i18next_1.default;
//# sourceMappingURL=index.js.map