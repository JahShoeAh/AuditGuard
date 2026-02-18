import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const STORY_STEPS = [
  {
    id: 'discovery',
    title: 'Contract Discovery',
    description: 'A Scanner Agent detects a new smart contract deployment on-chain and publishes a discovery event to the HCS network.',
    highlight: 'DiscoveryFeed',
    tab: 'liveFeed',
    duration: 6000,
  },
  {
    id: 'auction',
    title: 'Auction Opens',
    description: 'The Orchestrator creates an on-chain audit auction. Eligible agents receive invites and begin evaluating the opportunity.',
    highlight: 'AuctionFeed',
    tab: 'liveFeed',
    duration: 6000,
  },
  {
    id: 'bidding',
    title: 'Competitive Bidding',
    description: 'Auditor agents autonomously calculate bids based on contract complexity, their specialization, and dynamic pricing from past outcomes.',
    highlight: 'AuctionFeed',
    tab: 'liveFeed',
    duration: 6000,
  },
  {
    id: 'winner',
    title: 'Winner Selection',
    description: 'The Orchestrator scores bids (55% reputation, 25% price, 20% speed) and selects the winning agent combination.',
    highlight: 'AuctionFeed',
    tab: 'liveFeed',
    duration: 5000,
  },
  {
    id: 'subcontract',
    title: 'Agent-to-Agent Commerce',
    description: 'The LLM Agent sub-contracts dependency analysis to a specialized agent. The Static Analysis agent lists its scan report on the Data Marketplace.',
    highlight: 'MarketplacePanel',
    tab: 'liveFeed',
    duration: 7000,
  },
  {
    id: 'audit',
    title: 'Autonomous Auditing',
    description: 'Winning agents perform mock security analysis — static scans, fuzz testing, and deep semantic review. Findings are generated and hashed.',
    highlight: 'AuctionFeed',
    tab: 'liveFeed',
    duration: 6000,
  },
  {
    id: 'report',
    title: 'Report Aggregation',
    description: 'The Report Agent collects all findings, detects duplicates across agents, scores accuracy, and publishes the final report hash to HCS.',
    highlight: 'PaymentFlow',
    tab: 'liveFeed',
    duration: 6000,
  },
  {
    id: 'settlement',
    title: 'Payment Settlement',
    description: 'GUARD tokens are distributed atomically: audit payments, bonuses for critical findings, sub-contract payments, and platform fees to the treasury.',
    highlight: 'PaymentFlow',
    tab: 'liveFeed',
    duration: 6000,
  },
  {
    id: 'reputation',
    title: 'Reputation Update',
    description: 'Agent reputations evolve based on finding accuracy. High performers earn tier promotions; poor accuracy leads to slashing.',
    highlight: 'AgentLeaderboard',
    tab: 'agents',
    duration: 6000,
  },
  {
    id: 'complete',
    title: 'Cycle Complete',
    description: 'The entire audit lifecycle ran autonomously — no human intervention. The iNFT state is updated and the contract\'s health score is recorded.',
    highlight: null,
    tab: 'analytics',
    duration: 5000,
  },
];

export default function StoryMode({ isActive, onClose, onTabSwitch }) {
  const [currentStep, setCurrentStep] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const step = STORY_STEPS[currentStep];
  const progress = ((currentStep + 1) / STORY_STEPS.length) * 100;

  const advance = useCallback(() => {
    if (currentStep < STORY_STEPS.length - 1) {
      const nextStep = currentStep + 1;
      setCurrentStep(nextStep);
      if (STORY_STEPS[nextStep].tab && onTabSwitch) {
        onTabSwitch(STORY_STEPS[nextStep].tab);
      }
    } else {
      onClose();
    }
  }, [currentStep, onClose, onTabSwitch]);

  const goBack = useCallback(() => {
    if (currentStep > 0) {
      const prevStep = currentStep - 1;
      setCurrentStep(prevStep);
      if (STORY_STEPS[prevStep].tab && onTabSwitch) {
        onTabSwitch(STORY_STEPS[prevStep].tab);
      }
    }
  }, [currentStep, onTabSwitch]);

  useEffect(() => {
    if (!isActive || isPaused) return;
    const timer = setTimeout(advance, step.duration);
    return () => clearTimeout(timer);
  }, [isActive, isPaused, currentStep, advance, step.duration]);

  useEffect(() => {
    if (isActive && step.tab && onTabSwitch) {
      onTabSwitch(step.tab);
    }
  }, [isActive]);

  if (!isActive) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[600px] max-w-[95vw]"
      >
        <div className="bg-gray-900 border border-cyan-800 rounded-lg shadow-2xl shadow-cyan-900/20 overflow-hidden">
          {/* Progress bar */}
          <div className="h-1 bg-gray-800">
            <motion.div
              className="h-full bg-cyan-400"
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>

          <div className="p-4">
            {/* Step counter and controls */}
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono text-cyan-400 uppercase tracking-widest">
                Story Mode — Step {currentStep + 1}/{STORY_STEPS.length}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setIsPaused(p => !p)}
                  className="text-[10px] font-mono px-2 py-0.5 rounded bg-gray-800 text-gray-400 hover:text-white border border-gray-700"
                >
                  {isPaused ? 'PLAY' : 'PAUSE'}
                </button>
                <button
                  onClick={onClose}
                  className="text-[10px] font-mono px-2 py-0.5 rounded bg-gray-800 text-gray-400 hover:text-white border border-gray-700"
                >
                  EXIT
                </button>
              </div>
            </div>

            {/* Step content */}
            <AnimatePresence mode="wait">
              <motion.div
                key={step.id}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
              >
                <h3 className="text-sm font-bold text-white mb-1">{step.title}</h3>
                <p className="text-xs text-gray-400 leading-relaxed">{step.description}</p>
              </motion.div>
            </AnimatePresence>

            {/* Navigation */}
            <div className="flex justify-between mt-3">
              <button
                onClick={goBack}
                disabled={currentStep === 0}
                className="text-[10px] font-mono px-3 py-1 rounded bg-gray-800 text-gray-400 hover:text-white border border-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                BACK
              </button>
              <button
                onClick={advance}
                className="text-[10px] font-mono px-3 py-1 rounded bg-cyan-900 text-cyan-300 hover:bg-cyan-800 border border-cyan-700"
              >
                {currentStep === STORY_STEPS.length - 1 ? 'FINISH' : 'NEXT'}
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
