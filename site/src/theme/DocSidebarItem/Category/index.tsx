import type {ComponentProps, ReactNode} from 'react';
import clsx from 'clsx';
import {ThemeClassNames} from '@docusaurus/theme-common';
import {isActiveSidebarItem} from '@docusaurus/plugin-content-docs/client';
import OriginalCategory from '@theme-original/DocSidebarItem/Category';
import DocSidebarItems from '@theme/DocSidebarItems';
import styles from './styles.module.css';

type Props = ComponentProps<typeof OriginalCategory>;

// A category that neither collapses nor links is a group heading, so it renders as
// text: the classic theme draws it as an <a> with no href, which reads as a link that
// goes nowhere (and search engines count it as an uncrawlable one).
export default function DocSidebarItemCategory(props: Props): ReactNode {
  const {item, level, activePath, onItemClick} = props;
  if (item.collapsible || item.href) {
    return <OriginalCategory {...props} />;
  }
  return (
    <li
      className={clsx(
        ThemeClassNames.docs.docSidebarItemCategory,
        ThemeClassNames.docs.docSidebarItemCategoryLevel(level),
        'menu__list-item',
        item.className,
      )}>
      <div className="menu__list-item-collapsible">
        <span className={clsx('menu__link', styles.group, isActiveSidebarItem(item, activePath) && styles.active)}>
          {item.label}
        </span>
      </div>
      <ul className="menu__list">
        <DocSidebarItems items={item.items} tabIndex={0} onItemClick={onItemClick} activePath={activePath} level={level + 1} />
      </ul>
    </li>
  );
}
