// Local ESLint rules for the TamTam UI design system — see docs/UI.md

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const RGB_RE = /\brgb[a]?\s*\(/;

const BANNED_ICON_LIBS = [
  "lucide-react",
  "@heroicons/react",
  "react-icons",
  "phosphor-react",
  "@phosphor-icons/react",
  "@tabler/icons-react",
  "feather-icons-react",
];

const COLOR_STYLE_KEYS = new Set([
  "color",
  "background",
  "backgroundColor",
  "borderColor",
  "outlineColor",
  "fill",
  "stroke",
  "caretColor",
  "boxShadow",
  "textDecorationColor",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
]);

/** Rule: no-icon-library */
const noIconLibrary = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow icon library imports. Use inline SVG per UI.md.",
    },
    messages: {
      banned:
        "Do not import '{{ lib }}'. TamTam uses hand-rolled inline SVG icons (see docs/UI.md).",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const src = node.source.value;
        const hit = BANNED_ICON_LIBS.find(
          (lib) => src === lib || src.startsWith(lib + "/"),
        );
        if (hit) {
          context.report({ node, messageId: "banned", data: { lib: hit } });
        }
      },
    };
  },
};

/** Rule: no-hardcoded-color-style */
const noHardcodedColorStyle = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow hardcoded hex/rgb colors in JSX style props. Use CSS variable tokens (var(--color-*)).",
    },
    messages: {
      hardcoded:
        "Hardcoded color '{{ value }}' in style prop. Use a design token (var(--color-*)) per docs/UI.md.",
    },
  },
  create(context) {
    function isHardcoded(str) {
      return HEX_RE.test(str) || RGB_RE.test(str);
    }

    function checkPropValue(prop) {
      const key = prop.key?.name ?? prop.key?.value;
      if (!COLOR_STYLE_KEYS.has(key)) return;

      const val = prop.value;
      if (val.type === "Literal" && typeof val.value === "string") {
        if (isHardcoded(val.value)) {
          context.report({
            node: prop,
            messageId: "hardcoded",
            data: { value: val.value },
          });
        }
      } else if (val.type === "TemplateLiteral") {
        for (const quasi of val.quasis) {
          if (isHardcoded(quasi.value.raw)) {
            context.report({
              node: prop,
              messageId: "hardcoded",
              data: { value: quasi.value.raw },
            });
          }
        }
      }
    }

    return {
      JSXAttribute(node) {
        if (node.name?.name !== "style") return;
        const expr = node.value?.expression;
        if (!expr || expr.type !== "ObjectExpression") return;
        for (const prop of expr.properties) {
          if (prop.type === "Property") checkPropValue(prop);
        }
      },
    };
  },
};

/** Rule: no-font-family-override */
const noFontFamilyOverride = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow fontFamily in JSX style props. Use font-sans / font-mono Tailwind classes or var(--font-sans) / var(--font-mono).",
    },
    messages: {
      override:
        "Do not set fontFamily in style props. Use the Tailwind font-sans / font-mono classes or var(--font-sans) / var(--font-mono) per docs/UI.md.",
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name?.name !== "style") return;
        const expr = node.value?.expression;
        if (!expr || expr.type !== "ObjectExpression") return;

        for (const prop of expr.properties) {
          if (prop.type !== "Property") continue;
          const key = prop.key?.name ?? prop.key?.value;
          if (key !== "fontFamily") continue;

          const val = prop.value;
          if (val.type === "Literal" && typeof val.value === "string") {
            const raw = val.value;
            if (!raw.includes("--font-sans") && !raw.includes("--font-mono")) {
              context.report({ node: prop, messageId: "override" });
            }
          } else if (val.type === "TemplateLiteral") {
            const allowed = val.quasis.some(
              (q) =>
                q.value.raw.includes("--font-sans") ||
                q.value.raw.includes("--font-mono"),
            );
            if (!allowed) {
              context.report({ node: prop, messageId: "override" });
            }
          } else {
            context.report({ node: prop, messageId: "override" });
          }
        }
      },
    };
  },
};

export const rules = {
  "no-icon-library": noIconLibrary,
  "no-hardcoded-color-style": noHardcodedColorStyle,
  "no-font-family-override": noFontFamilyOverride,
};
