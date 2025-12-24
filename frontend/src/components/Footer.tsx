import React from "react";
import { useTranslation } from "react-i18next";
import Container from "./Container";

// 定义 props 类型，允许父组件传递控制弹窗显示的函数
interface FooterProps {
  onShowInfo: (infoType: 'privacy' | 'terms' | 'about') => void;
}

const Footer: React.FC<FooterProps> = ({ onShowInfo }) => {
  const { t } = useTranslation();
  const year = new Date().getFullYear();

  return (
    <footer className="border-t py-6">
      <Container>
        <div className="text-center text-sm text-muted-foreground">
          <p className="mb-2">
            © {year} {t("app.title")}
          </p>
        </div>
      </Container>
    </footer>
  );
};

export default Footer;
