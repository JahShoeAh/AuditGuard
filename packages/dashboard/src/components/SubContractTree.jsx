import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import useStore from '../store';
import SubAuctionCard from './SubAuctionCard';
import DataListingCard from './DataListingCard';

export default function SubContractTree({ parentJobId }) {
  const [expanded, setExpanded] = useState(false);

  const subJobIds = useStore((s) => s.parentSubJobs[parentJobId] || []);
  const listingIds = useStore((s) => s.jobListings[parentJobId] || []);

  const subCount = subJobIds.length;
  const dataCount = listingIds.length;
  const totalItems = subCount + dataCount;

  if (totalItems === 0) return null;

  const summary = [
    subCount > 0 && `${subCount} sub-task${subCount !== 1 ? 's' : ''}`,
    dataCount > 0 && `${dataCount} data sale${dataCount !== 1 ? 's' : ''}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="border-t border-white/[0.04]">
      {/* Collapse / expand toggle */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-white/[0.02] transition-colors text-left"
      >
        <motion.span
          animate={{ rotate: expanded ? 0 : -90 }}
          transition={{ duration: 0.18 }}
          className="text-[10px] font-mono text-gray-500 inline-block"
        >
          ▼
        </motion.span>
        <span
          className="text-[10px] font-semibold tracking-wider uppercase font-sans"
          style={{ color: 'var(--accent-purple)' }}
        >
          Agent Activity
        </span>
        <span className="text-[10px] text-gray-500 font-mono">({summary})</span>
      </button>

      {/* Animated tree body */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="subtree-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="relative px-3 pb-3 space-y-2">
              {/* Vertical dotted tree spine */}
              <div
                className="absolute top-0 bottom-3 pointer-events-none"
                style={{
                  left: '1rem',
                  borderLeft: '1px dotted rgba(255,255,255,0.1)',
                }}
              />

              {/* Sub-auctions */}
              {subJobIds.map((subJobId) => (
                <div key={subJobId} className="relative" style={{ paddingLeft: '1.25rem' }}>
                  {/* Horizontal branch connector */}
                  <div
                    className="absolute top-4 pointer-events-none"
                    style={{
                      left: '1rem',
                      width: '0.75rem',
                      borderTop: '1px dotted rgba(255,255,255,0.1)',
                    }}
                  />
                  <SubAuctionCard subJobId={subJobId} />
                </div>
              ))}

              {/* Data listings */}
              {listingIds.map((listingId) => (
                <div key={listingId} className="relative" style={{ paddingLeft: '1.25rem' }}>
                  <div
                    className="absolute top-4 pointer-events-none"
                    style={{
                      left: '1rem',
                      width: '0.75rem',
                      borderTop: '1px dotted rgba(255,255,255,0.1)',
                    }}
                  />
                  <DataListingCard listingId={listingId} />
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
